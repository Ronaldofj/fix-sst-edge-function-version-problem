import fs from "fs";
import path from "path";
import url from "url";
import { Lazy, Fn, Duration as CdkDuration, RemovalPolicy, CustomResource } from "aws-cdk-lib/core";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Code, Runtime, Architecture, Function as CdkFunction, FunctionUrlAuthType, } from "aws-cdk-lib/aws-lambda";
import { ViewerProtocolPolicy, AllowedMethods, CachedMethods, LambdaEdgeEventType, } from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Stack } from "sst/constructs/Stack.js";
import { Distribution } from "sst/constructs/Distribution.js";
import { SsrFunction } from "sst/constructs/SsrFunction.js";
import { EdgeFunction } from "sst/constructs/EdgeFunction.js";
import { SsrSite } from "sst/constructs/SsrSite.js";
import { toCdkSize } from "sst/constructs/util/size.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

class CustomEdgeFunction extends EdgeFunction {
    constructor(scope, id, props) {
        super(scope, id, props);
    }

    createVersionInUsEast1(fn, fnArn) {
        // Do not recreate if exist
        const providerId = "EdgeLambdaVersionProvider";
        const resId = `${this.node.id}EdgeLambdaVersion`;
        const stack = Stack.of(this);
        let provider = stack.node.tryFindChild(providerId);
        // Create provider if not already created
        if (!provider) {
            provider = new CdkFunction(stack, providerId, {
                code: Code.fromAsset(path.join(__dirname, "./sst/support/edge-function")),
                handler: "edge-lambda-version.handler",
                runtime: Runtime.NODEJS_16_X,
                timeout: CdkDuration.minutes(15),
                memorySize: 1024,
                initialPolicy: [
                    new PolicyStatement({
                        effect: Effect.ALLOW,
                        actions: ["lambda:*"],
                        resources: ["*"],
                    }),
                ],
            });
        }
        // Create custom resource

        const version = new CustomResource(this.scope, resId, {
            serviceToken: provider.functionArn,
            resourceType: "Custom::SSTEdgeLambdaVersion",
            properties: {
                FunctionArn: fnArn,
            },
        });

        // Override the version's logical ID with a lazy string which includes the
        // hash of the function itself, so a new version resource is created when
        // the function configuration changes.
        const cfn = version.node.defaultChild;
        const originalLogicalId = Stack.of(version).resolve(cfn.logicalId);
        cfn.overrideLogicalId(Lazy.uncachedString({
            produce: () => {
                const hash = this.calculateHash(fn);
                const logicalId = this.trimFromStart(originalLogicalId, 255 - 32);
                return `${logicalId}${hash}`;
            },
        }));
        return { version, versionId: version.getAttString("Version") };
    }
}

export class NextSite extends SsrSite {
    constructor(scope, id, props) {
        super(scope, id, {
            buildCommand: "npx --yes open-next@2.1.5 build",
            ...props,
        });
        this.deferredTaskCallbacks.push(() => {
            this.createRevalidation();
        });
    }
    createRevalidation() {
        if (!this.serverLambdaForRegional && !this.serverLambdaForEdge)
            return;
        const { cdk } = this.props;
        const queue = new Queue(this, "RevalidationQueue", {
            fifo: true,
            receiveMessageWaitTime: CdkDuration.seconds(20),
        });
        const consumer = new CdkFunction(this, "RevalidationFunction", {
            description: "Next.js revalidator",
            handler: "index.handler",
            code: Code.fromAsset(path.join(this.props.path, ".open-next", "revalidation-function")),
            runtime: Runtime.NODEJS_18_X,
            timeout: CdkDuration.seconds(30),
            ...cdk?.revalidation,
        });
        consumer.addEventSource(new SqsEventSource(queue, { batchSize: 5 }));
        // Allow server to send messages to the queue
        const server = this.serverLambdaForRegional || this.serverLambdaForEdge;
        server?.addEnvironment("REVALIDATION_QUEUE_URL", queue.queueUrl);
        server?.addEnvironment("REVALIDATION_QUEUE_REGION", Stack.of(this).region);
        queue.grantSendMessages(server?.role);
    }
    initBuildConfig() {
        return {
            typesPath: ".",
            serverBuildOutputFile: ".open-next/server-function/index.mjs",
            clientBuildOutputDir: ".open-next/assets",
            clientBuildVersionedSubDir: "_next",
            clientBuildS3KeyPrefix: "_assets",
            prerenderedBuildOutputDir: ".open-next/cache",
            prerenderedBuildS3KeyPrefix: "_cache",
            warmerFunctionAssetPath: path.join(this.props.path, ".open-next/warmer-function"),
        };
    }
    createFunctionForRegional() {
        const { runtime, timeout, memorySize, bind, permissions, environment, cdk, } = this.props;
        return new SsrFunction(this, `ServerFunction`, {
            description: "Next.js server",
            bundle: path.join(this.props.path, ".open-next", "server-function"),
            handler: "index.handler",
            runtime,
            timeout,
            memorySize,
            bind,
            permissions,
            environment: {
                ...environment,
                CACHE_BUCKET_NAME: this.bucket.bucketName,
                CACHE_BUCKET_KEY_PREFIX: "_cache",
                CACHE_BUCKET_REGION: Stack.of(this).region,
            },
            ...cdk?.server,
        });
    }
    createFunctionForEdge() {
        const { runtime, timeout, memorySize, bind, permissions, environment } = this.props;
        return new CustomEdgeFunction(this, "ServerFunction", {
            bundle: path.join(this.props.path, ".open-next", "server-function"),
            handler: "index.handler",
            runtime,
            timeout,
            memorySize,
            bind,
            permissions,
            environment: {
                ...environment,
                CACHE_BUCKET_NAME: this.bucket.bucketName,
                CACHE_BUCKET_KEY_PREFIX: "_cache",
                CACHE_BUCKET_REGION: Stack.of(this).region,
            },
        });
    }
    createImageOptimizationFunction() {
        const { imageOptimization, path: sitePath } = this.props;
        const fn = new CdkFunction(this, `ImageFunction`, {
            description: "Next.js image optimizer",
            handler: "index.handler",
            currentVersionOptions: {
                removalPolicy: RemovalPolicy.DESTROY,
            },
            logRetention: RetentionDays.THREE_DAYS,
            code: Code.fromInline("export function handler() {}"),
            runtime: Runtime.NODEJS_18_X,
            memorySize: imageOptimization?.memorySize
                ? typeof imageOptimization.memorySize === "string"
                    ? toCdkSize(imageOptimization.memorySize).toMebibytes()
                    : imageOptimization.memorySize
                : 1536,
            timeout: CdkDuration.seconds(25),
            architecture: Architecture.ARM_64,
            environment: {
                BUCKET_NAME: this.bucket.bucketName,
                BUCKET_KEY_PREFIX: "_assets",
            },
            initialPolicy: [
                new PolicyStatement({
                    actions: ["s3:GetObject"],
                    resources: [this.bucket.arnForObjects("*")],
                }),
            ],
        });
        // update code after build
        this.deferredTaskCallbacks.push(() => {
            const cfnFunction = fn.node.defaultChild;
            const code = Code.fromAsset(path.join(sitePath, ".open-next/image-optimization-function"));
            const codeConfig = code.bind(fn);
            cfnFunction.code = {
                s3Bucket: codeConfig.s3Location?.bucketName,
                s3Key: codeConfig.s3Location?.objectKey,
                s3ObjectVersion: codeConfig.s3Location?.objectVersion,
            };
            code.bindToResource(cfnFunction);
        });
        return fn;
    }
    createCloudFrontDistributionForRegional() {
        /**
         * Next.js requests
         *
         * - Public asset
         *  Use case: When you request an asset in /public
         *  Request: /myImage.png
         *  Response cache:
         *  - Cache-Control: public, max-age=0, must-revalidate
         *  - x-vercel-cache: MISS (1st request)
         *  - x-vercel-cache: HIT (2nd request)
         *
         * - SSG page
         *  Use case: When you request an SSG page directly
         *  Request: /myPage
         *  Response cache:
         *  - Cache-Control: public, max-age=0, must-revalidate
         *  - Content-Encoding: br
         *  - x-vercel-cache: HIT (2nd request, not set for 1st request)
         *
         * - SSR page (directly)
         *  Use case: When you request an SSR page directly
         *  Request: /myPage
         *  Response cache:
         *  - Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
         *  - x-vercel-cache: MISS
         *
         * - SSR pages (user transition)
         *  Use case: When the page uses getServerSideProps(), and you request this page on
         *            client-side page trasitions. Next.js sends an API request to the server,
         *            which runs getServerSideProps()
         *  Request: /_next/data/_-fpIB1rqWyRD-EJO59pO/myPage.json
         *  Response cache:
         *  - Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
         *  - x-vercel-cache: MISS
         *
         * - Image optimization
         *  Use case: when you request an image
         *  Request: /_next/image?url=%2F_next%2Fstatic%2Fmedia%2F4600x4600.ce39e3d6.jpg&w=256&q=75
         *  Response cache:
         *    - Cache-Control: public, max-age=31536000, immutable
         *    - x-vercel-cache: HIT
         *
         * - API
         *  Use case: when you request an API endpoint
         *  Request: /api/hello
         *  Response cache:
         *    - Cache-Control: public, max-age=0, must-revalidate
         *    - x-vercel-cache: MISS
         */
        const { customDomain, cdk } = this.props;
        const cfDistributionProps = cdk?.distribution || {};
        const serverBehavior = this.buildDefaultBehaviorForRegional();
        return new Distribution(this, "CDN", {
            scopeOverride: this,
            customDomain,
            cdk: {
                distribution: {
                    // these values can be overwritten by cfDistributionProps
                    defaultRootObject: "",
                    // Override props.
                    ...cfDistributionProps,
                    // these values can NOT be overwritten by cfDistributionProps
                    defaultBehavior: serverBehavior,
                    additionalBehaviors: {
                        "api/*": serverBehavior,
                        "_next/data/*": serverBehavior,
                        "_next/image*": this.buildImageBehavior(),
                        ...(cfDistributionProps.additionalBehaviors || {}),
                    },
                },
            },
        });
    }
    createCloudFrontDistributionForEdge() {
        const { customDomain, cdk } = this.props;
        const cfDistributionProps = cdk?.distribution || {};
        const serverBehavior = this.buildDefaultBehaviorForEdge();
        return new Distribution(this, "CDN", {
            scopeOverride: this,
            customDomain,
            cdk: {
                distribution: {
                    // these values can be overwritten by cfDistributionProps
                    defaultRootObject: "",
                    // Override props.
                    ...cfDistributionProps,
                    // these values can NOT be overwritten by cfDistributionProps
                    defaultBehavior: serverBehavior,
                    additionalBehaviors: {
                        "api/*": serverBehavior,
                        "_next/data/*": serverBehavior,
                        // "_next/image*": this.buildImageBehavior(),
                        ...(cfDistributionProps.additionalBehaviors || {}),
                    },
                },
            },
        });
    }
    useServerBehaviorCachePolicy() {
        return super.useServerBehaviorCachePolicy([
            "accept",
            "rsc",
            "next-router-prefetch",
            "next-router-state-tree",
            "next-url",
        ]);
    }
    buildImageBehavior() {
        const { cdk, regional } = this.props;
        const imageFn = this.createImageOptimizationFunction();
        const imageFnUrl = imageFn.addFunctionUrl({
            authType: regional?.enableServerUrlIamAuth
                ? FunctionUrlAuthType.AWS_IAM
                : FunctionUrlAuthType.NONE,
        });
        return {
            viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            origin: new HttpOrigin(Fn.parseDomainName(imageFnUrl.url)),
            allowedMethods: AllowedMethods.ALLOW_ALL,
            cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
            compress: true,
            cachePolicy: cdk?.serverCachePolicy ?? this.useServerBehaviorCachePolicy(),
            responseHeadersPolicy: cdk?.responseHeadersPolicy,
            edgeLambdas: regional?.enableServerUrlIamAuth
                ? [
                    (() => {
                        const fn = this.useServerUrlSigningFunction();
                        fn.attachPermissions([
                            new PolicyStatement({
                                actions: ["lambda:InvokeFunctionUrl"],
                                resources: [imageFn.functionArn],
                            }),
                        ]);
                        return {
                            includeBody: true,
                            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
                            functionVersion: fn.currentVersion,
                        };
                    })(),
                ]
                : [],
        };
    }
    generateBuildId() {
        const filePath = path.join(this.props.path, ".next/BUILD_ID");
        return fs.readFileSync(filePath).toString();
    }
    getConstructMetadata() {
        return {
            type: "NextjsSite",
            ...this.getConstructMetadataBase(),
        };
    }
}

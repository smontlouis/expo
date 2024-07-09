/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { getConfig } from '@expo/config';
import * as runtimeEnv from '@expo/env';
import { SerialAsset } from '@expo/metro-config/build/serializer/serializerAssets';
import assert from 'assert';
import chalk from 'chalk';
import { TransformInputOptions } from 'metro';
import baseJSBundle from 'metro/src/DeltaBundler/Serializers/baseJSBundle';
import {
  sourceMapGeneratorNonBlocking,
  type SourceMapGeneratorOptions,
} from 'metro/src/DeltaBundler/Serializers/sourceMapGenerator';
import bundleToString from 'metro/src/lib/bundleToString';
import { TransformProfile } from 'metro-babel-transformer';
import type { CustomResolverOptions } from 'metro-resolver/src/types';
import path from 'path';
import { getRscMiddleware } from '@expo/server/build/middleware/rsc';
import { ExpoRouterServerManifestV1, fetchManifest } from './fetchRouterManifest';
import { instantiateMetroAsync } from './instantiateMetro';
import { getErrorOverlayHtmlAsync, logMetroError } from './metroErrorInterface';
import { MetroPrivateServer, assertMetroPrivateServer } from './metroPrivateServer';
import { metroWatchTypeScriptFiles } from './metroWatchTypeScriptFiles';
import {
  getRouterDirectoryModuleIdWithManifest,
  hasWarnedAboutApiRoutes,
  isApiRouteConvention,
  warnInvalidWebOutput,
} from './router';
import { serializeHtmlWithAssets } from './serializeHtml';
import { observeAnyFileChanges, observeFileChanges } from './waitForMetroToObserveTypeScriptFile';
import { BundleAssetWithFileHashes, ExportAssetMap } from '../../../export/saveAssets';
import { Log } from '../../../log';
import getDevClientProperties from '../../../utils/analytics/getDevClientProperties';
import { stripAnsi } from '../../../utils/ansi';
import { env } from '../../../utils/env';
import { CommandError } from '../../../utils/errors';
import { getFreePortAsync } from '../../../utils/port';
import { logEventAsync } from '../../../utils/telemetry';
import { BundlerDevServer, BundlerStartOptions, DevServerInstance } from '../BundlerDevServer';
import {
  cachedSourceMaps,
  // evalMetroNoHandling,
  evalMetroAndWrapFunctions,
  evalMetroNoHandling,
} from '../getStaticRenderFunctions';
import { ContextModuleSourceMapsMiddleware } from '../middleware/ContextModuleSourceMapsMiddleware';
import { CreateFileMiddleware } from '../middleware/CreateFileMiddleware';
import { DevToolsPluginMiddleware } from '../middleware/DevToolsPluginMiddleware';
import { FaviconMiddleware } from '../middleware/FaviconMiddleware';
import { HistoryFallbackMiddleware } from '../middleware/HistoryFallbackMiddleware';
import { InterstitialPageMiddleware } from '../middleware/InterstitialPageMiddleware';
import { getMetroServerRoot, resolveMainModuleName } from '../middleware/ManifestMiddleware';
import { ReactDevToolsPageMiddleware } from '../middleware/ReactDevToolsPageMiddleware';
import {
  DeepLinkHandler,
  RuntimeRedirectMiddleware,
} from '../middleware/RuntimeRedirectMiddleware';
import { ServeStaticMiddleware } from '../middleware/ServeStaticMiddleware';
import {
  ExpoMetroOptions,
  convertPathToModuleSpecifier,
  createBundleUrlPath,
  getAsyncRoutesFromExpoConfig,
  getBaseUrlFromExpoConfig,
  getMetroDirectBundleOptions,
  shouldEnableAsyncImports,
  createBundleUrlSearchParams,
} from '../middleware/metroOptions';
import { prependMiddleware } from '../middleware/mutations';
import { startTypescriptTypeGenerationAsync } from '../type-generation/startTypescriptTypeGeneration';

import { EntriesPrd } from 'expo-router/build/rsc/server';
import resolveFrom from 'resolve-from';
export type ExpoRouterRuntimeManifest = Awaited<
  ReturnType<typeof import('expo-router/build/static/renderStaticContent').getManifest>
>;
import MetroHmrServer from 'metro/src/HmrServer';
import { createBuiltinAPIRequestHandler } from '../middleware/createBuiltinAPIRequestHandler';
import { createRouteHandlerMiddleware } from './createServerRouteMiddleware';

type MetroOnProgress = NonNullable<
  import('metro/src/DeltaBundler/types').Options<void>['onProgress']
>;

const debug = require('debug')('expo:start:server:metro') as typeof console.log;

const getGraphId = require('metro/src/lib/getGraphId') as (
  entryFile: string,
  options: any,
  etc: {
    shallow: boolean;
    lazy: boolean;
    unstable_allowRequireContext: boolean;
    resolverOptions: unknown;
  }
) => string;

/** Default port to use for apps running in Expo Go. */
const EXPO_GO_METRO_PORT = 8081;

/** Default port to use for apps that run in standard React Native projects or Expo Dev Clients. */
const DEV_CLIENT_METRO_PORT = 8081;

export class MetroBundlerDevServer extends BundlerDevServer {
  private metro: MetroPrivateServer | null = null;
  private hmrServer: MetroHmrServer | null = null;

  get name(): string {
    return 'metro';
  }

  async resolvePortAsync(options: Partial<BundlerStartOptions> = {}): Promise<number> {
    const port =
      // If the manually defined port is busy then an error should be thrown...
      options.port ??
      // Otherwise use the default port based on the runtime target.
      (options.devClient
        ? // Don't check if the port is busy if we're using the dev client since most clients are hardcoded to 8081.
          Number(process.env.RCT_METRO_PORT) || DEV_CLIENT_METRO_PORT
        : // Otherwise (running in Expo Go) use a free port that falls back on the classic 8081 port.
          await getFreePortAsync(EXPO_GO_METRO_PORT));

    return port;
  }

  async exportExpoRouterApiRoutesAsync({
    includeSourceMaps,
    outputDir,
    prerenderManifest,
    platform,
  }: {
    includeSourceMaps?: boolean;
    outputDir: string;
    // This does not contain the API routes info.
    prerenderManifest: ExpoRouterServerManifestV1;
    platform: string;
  }): Promise<{ files: ExportAssetMap; manifest: ExpoRouterServerManifestV1<string> }> {
    const { routerRoot } = this.instanceMetroOptions;
    assert(
      routerRoot != null,
      'The server must be started before calling exportExpoRouterApiRoutesAsync.'
    );

    const appDir = path.join(this.projectRoot, routerRoot);
    const manifest = await this.getExpoRouterRoutesManifestAsync({ appDir });

    const files: ExportAssetMap = new Map();

    for (const route of manifest.apiRoutes) {
      const filepath = path.join(appDir, route.file);
      const contents = await this.bundleApiRoute(filepath, { platform });
      const artifactFilename = path.join(
        outputDir,
        path.relative(appDir, filepath.replace(/\.[tj]sx?$/, '.js'))
      );
      if (contents) {
        let src = contents.src;

        if (includeSourceMaps && contents.map) {
          // TODO(kitten): Merge the source map transformer in the future
          // https://github.com/expo/expo/blob/0dffdb15/packages/%40expo/metro-config/src/serializer/serializeChunks.ts#L422-L439
          // Alternatively, check whether `sourcesRoot` helps here
          const artifactBasename = encodeURIComponent(path.basename(artifactFilename) + '.map');
          src = src.replace(
            /\/\/# sourceMappingURL=.*/g,
            `//# sourceMappingURL=${artifactBasename}`
          );

          const parsedMap =
            typeof contents.map === 'string' ? JSON.parse(contents.map) : contents.map;
          files.set(artifactFilename + '.map', {
            contents: JSON.stringify({
              version: parsedMap.version,
              sources: parsedMap.sources.map((source: string) => {
                source =
                  typeof source === 'string' && source.startsWith(this.projectRoot)
                    ? path.relative(this.projectRoot, source)
                    : source;
                return convertPathToModuleSpecifier(source);
              }),
              sourcesContent: new Array(parsedMap.sources.length).fill(null),
              names: parsedMap.names,
              mappings: parsedMap.mappings,
            }),
            apiRouteId: route.page,
            targetDomain: 'server',
          });
        }
        files.set(artifactFilename, {
          contents: src,
          apiRouteId: route.page,
          targetDomain: 'server',
        });
      }
      // Remap the manifest files to represent the output files.
      route.file = artifactFilename;
    }

    return {
      manifest: {
        ...manifest,
        htmlRoutes: prerenderManifest.htmlRoutes,
      },
      files,
    };
  }

  async getExpoRouterRoutesManifestAsync({ appDir }: { appDir: string }) {
    // getBuiltTimeServerManifest
    const { exp } = getConfig(this.projectRoot);
    const manifest = await fetchManifest(this.projectRoot, {
      ...exp.extra?.router?.platformRoutes,
      asJson: true,
      appDir,
    });

    if (!manifest) {
      throw new CommandError(
        'EXPO_ROUTER_SERVER_MANIFEST',
        'Unexpected error: server manifest could not be fetched.'
      );
    }

    return manifest;
  }

  async getServerManifestAsync(): Promise<{
    serverManifest: ExpoRouterServerManifestV1;
  }> {
    const { mode, minify, isExporting } = this.instanceMetroOptions;
    assert(
      mode != null && isExporting != null,
      'The server must be started before calling ssrLoadModule.'
    );

    const { getBuildTimeServerManifestAsync } = await this.ssrLoadModule<
      typeof import('expo-router/build/static/server-manifest')
    >('expo-router/build/static/server-manifest.js', {
      minify,
      environment: 'react-server',
      isExporting,
    });

    return {
      serverManifest: await getBuildTimeServerManifestAsync(),
    };
  }

  async getStaticRenderFunctionAsync(): Promise<{
    serverManifest: ExpoRouterServerManifestV1;
    manifest: ExpoRouterRuntimeManifest;
    renderAsync: (path: string) => Promise<string>;
  }> {
    const url = this.getDevServerUrlOrAssert();

    const { getStaticContent, getManifest, getBuildTimeServerManifestAsync } =
      await this.ssrLoadModule<typeof import('expo-router/build/static/renderStaticContent')>(
        'expo-router/node/render.js'
      );

    const { exp } = getConfig(this.projectRoot);

    return {
      serverManifest: await getBuildTimeServerManifestAsync(),
      // Get routes from Expo Router.
      manifest: await getManifest({ preserveApiRoutes: false, ...exp.extra?.router }),
      // Get route generating function
      async renderAsync(path: string) {
        return await getStaticContent(new URL(path, url));
      },
    };
  }

  async getStaticResourcesAsync({
    includeSourceMaps,
    mainModuleName,
    clientBoundaries = this.instanceMetroOptions.clientBoundaries ?? [],
    platform = 'web',
  }: {
    includeSourceMaps?: boolean;
    mainModuleName?: string;
    clientBoundaries?: string[];
    platform?: string;
  } = {}) {
    const { mode, minify, isExporting, baseUrl, reactCompiler, routerRoot, asyncRoutes } =
      this.instanceMetroOptions;
    assert(
      mode != null &&
        isExporting != null &&
        baseUrl != null &&
        routerRoot != null &&
        reactCompiler != null &&
        asyncRoutes != null,
      'The server must be started before calling getStaticResourcesAsync.'
    );

    const resolvedMainModuleName =
      mainModuleName ?? './' + resolveMainModuleName(this.projectRoot, { platform });
    return await this.metroImportAsArtifactsAsync(resolvedMainModuleName, {
      splitChunks: isExporting && !env.EXPO_NO_BUNDLE_SPLITTING,
      platform,
      mode,
      minify,
      environment: 'client',
      serializerIncludeMaps: includeSourceMaps,
      mainModuleName: resolvedMainModuleName,
      lazy: shouldEnableAsyncImports(this.projectRoot),
      asyncRoutes,
      baseUrl,
      isExporting,
      routerRoot,
      clientBoundaries,
      reactCompiler,
      bytecode: false,
    });
  }

  private async getStaticPageAsync(pathname: string) {
    const { mode, isExporting, clientBoundaries, baseUrl, reactCompiler, routerRoot, asyncRoutes } =
      this.instanceMetroOptions;
    assert(
      mode != null &&
        isExporting != null &&
        baseUrl != null &&
        reactCompiler != null &&
        routerRoot != null &&
        asyncRoutes != null,
      'The server must be started before calling getStaticPageAsync.'
    );
    const platform = 'web';

    const devBundleUrlPathname = createBundleUrlPath({
      splitChunks: isExporting && !env.EXPO_NO_BUNDLE_SPLITTING,
      platform,
      mode,
      environment: 'client',
      reactCompiler,
      mainModuleName: resolveMainModuleName(this.projectRoot, { platform }),
      lazy: shouldEnableAsyncImports(this.projectRoot),
      baseUrl,
      isExporting,
      asyncRoutes,
      routerRoot,
      clientBoundaries,
      bytecode: false,
    });

    const bundleStaticHtml = async (): Promise<string> => {
      const { getStaticContent } = await this.ssrLoadModule<
        typeof import('expo-router/build/static/renderStaticContent')
      >('expo-router/node/render.js', {
        minify: false,
        isExporting,
        platform,
      });

      const location = new URL(pathname, this.getDevServerUrlOrAssert());
      return await getStaticContent(location);
    };

    const [{ artifacts: resources }, staticHtml] = await Promise.all([
      this.getStaticResourcesAsync({
        // TODO(Bacon): Check this
        clientBoundaries: [],
      }),
      bundleStaticHtml(),
    ]);
    const content = serializeHtmlWithAssets({
      isExporting,
      resources,
      template: staticHtml,
      devBundleUrl: devBundleUrlPathname,
      baseUrl,
    });
    return {
      content,
      resources,
    };
  }

  // Set when the server is started.
  private instanceMetroOptions: Partial<ExpoMetroOptions> = {};

  private ssrLoadModule: SSRLoadModuleFunc = async (
    filePath,
    specificOptions = {},
    extras = {}
  ) => {
    const res = await this.ssrLoadModuleContents(filePath, specificOptions);

    if (extras.hot) {
      // Register SSR HMR
      const serverRoot = getMetroServerRoot(this.projectRoot);
      const relativePath = path.relative(serverRoot, res.filename);
      const url = new URL(relativePath, this.getDevServerUrlOrAssert());
      this.setupHmr(url);
    }

    return evalMetroAndWrapFunctions(this.projectRoot, res.src, res.filename);
  };

  private async metroImportAsArtifactsAsync(
    filePath: string,
    specificOptions: Partial<Omit<ExpoMetroOptions, 'serializerOutput'>> = {}
  ) {
    const results = await this.ssrLoadModuleContents(filePath, {
      serializerOutput: 'static',
      ...specificOptions,
    });

    // NOTE: This could potentially need more validation in the future.
    if (results.artifacts && results.assets) {
      return {
        artifacts: results.artifacts,
        assets: results.assets,
        src: results.src,
        filename: results.filename,
        map: results.map,
      };
    }
    throw new CommandError('Invalid bundler results: ' + results);
  }

  private async metroLoadModuleContents(
    filePath: string,
    specificOptions: ExpoMetroOptions,
    extraOptions: {
      sourceMapUrl?: string;
      unstable_transformProfile?: TransformProfile;
    } = {}
  ) {
    const { baseUrl } = this.instanceMetroOptions;
    assert(baseUrl != null, 'The server must be started before calling metroLoadModuleContents.');

    const opts: ExpoMetroOptions = {
      // TODO: Possibly issues with using an absolute path here...
      // mainModuleName: filePath,
      lazy: false,
      asyncRoutes: false,
      inlineSourceMap: false,
      engine: 'hermes',
      minify: false,
      // bytecode: false,
      // Bundle in Node.js mode for SSR.
      environment: 'node',
      // platform: 'web',
      // mode: 'development',
      //
      ...this.instanceMetroOptions,
      baseUrl,
      // routerRoot,
      // isExporting,
      ...specificOptions,
    };

    const expoBundleOptions = getMetroDirectBundleOptions(opts);

    const resolverOptions = {
      customResolverOptions: expoBundleOptions.customResolverOptions ?? {},
      dev: expoBundleOptions.dev ?? true,
    };

    const transformOptions: TransformInputOptions = {
      dev: expoBundleOptions.dev ?? true,
      hot: true,
      minify: expoBundleOptions.minify ?? false,
      type: 'module',
      unstable_transformProfile:
        extraOptions.unstable_transformProfile ??
        expoBundleOptions.unstable_transformProfile ??
        'default',
      customTransformOptions: expoBundleOptions.customTransformOptions ?? Object.create(null),
      platform: expoBundleOptions.platform ?? 'web',
      runtimeBytecodeVersion: expoBundleOptions.runtimeBytecodeVersion,
    };

    const resolvedEntryFilePath = await this.resolveRelativePathAsync(filePath, {
      resolverOptions,
      transformOptions,
    });

    // Use fully qualified URL with all options to represent the file path that's used for source maps and HMR. This prevents collisions.
    const filename = createBundleUrlPath({
      ...opts,
      mainModuleName: resolvedEntryFilePath,
    });

    // https://github.com/facebook/metro/blob/2405f2f6c37a1b641cc379b9c733b1eff0c1c2a1/packages/metro/src/lib/parseOptionsFromUrl.js#L55-L87
    const results = await this._bundleDirectAsync(resolvedEntryFilePath, {
      graphOptions: {
        lazy: expoBundleOptions.lazy ?? false,
        shallow: expoBundleOptions.shallow ?? false,
      },
      resolverOptions,
      serializerOptions: {
        ...expoBundleOptions.serializerOptions,

        inlineSourceMap: expoBundleOptions.inlineSourceMap ?? false,
        modulesOnly: expoBundleOptions.modulesOnly ?? false,
        runModule: expoBundleOptions.runModule ?? true,
        // @ts-expect-error
        sourceUrl: expoBundleOptions.sourceUrl,
        // @ts-expect-error
        sourceMapUrl: extraOptions.sourceMapUrl ?? expoBundleOptions.sourceMapUrl,
      },
      transformOptions,
    });

    return {
      ...results,
      filename,
    };
  }

  private async ssrLoadModuleContents(
    filePath: string,
    specificOptions: Partial<ExpoMetroOptions> = {}
  ) {
    const { baseUrl, routerRoot, isExporting } = this.instanceMetroOptions;
    assert(
      baseUrl != null && routerRoot != null && isExporting != null,
      'The server must be started before calling ssrLoadModuleContents.'
    );

    const opts: ExpoMetroOptions = {
      // TODO: Possibly issues with using an absolute path here...
      mainModuleName: convertPathToModuleSpecifier(filePath),
      lazy: false,
      asyncRoutes: false,
      inlineSourceMap: false,
      engine: 'hermes',
      minify: false,
      bytecode: false,
      // Bundle in Node.js mode for SSR.
      environment: 'node',
      platform: 'web',
      mode: 'development',
      //
      ...this.instanceMetroOptions,

      // Mostly disable compiler in SSR bundles.
      reactCompiler: false,
      baseUrl,
      routerRoot,
      isExporting,

      ...specificOptions,
    };

    // https://github.com/facebook/metro/blob/2405f2f6c37a1b641cc379b9c733b1eff0c1c2a1/packages/metro/src/lib/parseOptionsFromUrl.js#L55-L87
    const { filename, bundle, map, ...rest } = await this.metroLoadModuleContents(filePath, opts);
    const scriptContents = wrapBundle(bundle);

    if (map) {
      debug('Registering SSR source map for:', filename);
      cachedSourceMaps.set(filename, { url: this.projectRoot, map });
    } else {
      debug('No SSR source map found for:', filename);
    }

    return {
      ...rest,
      src: scriptContents,
      filename,
      map,
    };
  }

  async legacySinglePageExportBundleAsync(
    options: Omit<
      ExpoMetroOptions,
      'baseUrl' | 'routerRoot' | 'asyncRoutes' | 'isExporting' | 'serializerOutput' | 'environment'
    >,
    extraOptions: {
      sourceMapUrl?: string;
      unstable_transformProfile?: TransformProfile;
    } = {}
  ): Promise<{ artifacts: SerialAsset[]; assets: readonly BundleAssetWithFileHashes[] }> {
    const { baseUrl, routerRoot, isExporting } = this.instanceMetroOptions;
    assert(
      baseUrl != null && routerRoot != null && isExporting != null,
      'The server must be started before calling legacySinglePageExportBundleAsync.'
    );

    const opts: ExpoMetroOptions = {
      ...this.instanceMetroOptions,
      baseUrl,
      routerRoot,
      isExporting,
      ...options,
      environment: 'client',
      serializerOutput: 'static',
    };

    // https://github.com/facebook/metro/blob/2405f2f6c37a1b641cc379b9c733b1eff0c1c2a1/packages/metro/src/lib/parseOptionsFromUrl.js#L55-L87
    if (!opts.mainModuleName.startsWith('/')) {
      opts.mainModuleName = './' + opts.mainModuleName;
    }

    const output = await this.metroLoadModuleContents(opts.mainModuleName, opts, extraOptions);

    return {
      artifacts: output.artifacts!,
      assets: output.assets!,
    };
  }

  async watchEnvironmentVariables() {
    if (!this.instance) {
      throw new Error(
        'Cannot observe environment variable changes without a running Metro instance.'
      );
    }
    if (!this.metro) {
      // This can happen when the run command is used and the server is already running in another
      // process.
      debug('Skipping Environment Variable observation because Metro is not running (headless).');
      return;
    }

    const envFiles = runtimeEnv
      .getFiles(process.env.NODE_ENV)
      .map((fileName) => path.join(this.projectRoot, fileName));

    observeFileChanges(
      {
        metro: this.metro,
        server: this.instance.server,
      },
      envFiles,
      () => {
        debug('Reloading environment variables...');
        // Force reload the environment variables.
        runtimeEnv.load(this.projectRoot, { force: true });
      }
    );
  }

  protected async startImplementationAsync(
    options: BundlerStartOptions
  ): Promise<DevServerInstance> {
    options.port = await this.resolvePortAsync(options);
    this.urlCreator = this.getUrlCreator(options);

    const config = getConfig(this.projectRoot, { skipSDKVersionRequirement: true });
    const { exp } = config;
    const useServerRendering = ['static', 'server'].includes(exp.web?.output ?? '');
    const baseUrl = getBaseUrlFromExpoConfig(exp);
    const asyncRoutes = getAsyncRoutesFromExpoConfig(exp, options.mode ?? 'development', 'web');
    const routerRoot = getRouterDirectoryModuleIdWithManifest(this.projectRoot, exp);
    const rscPath = '/_flight';
    const reactCompiler = !!exp.experiments?.reactCompiler;
    const appDir = path.join(this.projectRoot, routerRoot);
    const mode = options.mode ?? 'development';

    this.instanceMetroOptions = {
      isExporting: !!options.isExporting,
      baseUrl,
      mode,
      routerRoot,
      reactCompiler,
      minify: options.minify,
      asyncRoutes,
      // Options that are changing between platforms like engine, platform, and environment aren't set here.
    };

    const parsedOptions = {
      port: options.port,
      maxWorkers: options.maxWorkers,
      resetCache: options.resetDevServer,
    };

    // Required for symbolication:
    process.env.EXPO_DEV_SERVER_ORIGIN = `http://localhost:${options.port}`;

    const { metro, hmrServer, server, middleware, messageSocket } = await instantiateMetroAsync(
      this,
      parsedOptions,
      {
        isExporting: !!options.isExporting,
        exp,
      }
    );

    if (!options.isExporting) {
      const manifestMiddleware = await this.getManifestMiddlewareAsync(options);

      // Important that we noop source maps for context modules as soon as possible.
      prependMiddleware(middleware, new ContextModuleSourceMapsMiddleware().getHandler());

      // We need the manifest handler to be the first middleware to run so our
      // routes take precedence over static files. For example, the manifest is
      // served from '/' and if the user has an index.html file in their project
      // then the manifest handler will never run, the static middleware will run
      // and serve index.html instead of the manifest.
      // https://github.com/expo/expo/issues/13114
      prependMiddleware(middleware, manifestMiddleware.getHandler());

      middleware.use(
        new InterstitialPageMiddleware(this.projectRoot, {
          // TODO: Prevent this from becoming stale.
          scheme: options.location.scheme ?? null,
        }).getHandler()
      );
      middleware.use(new ReactDevToolsPageMiddleware(this.projectRoot).getHandler());
      middleware.use(
        new DevToolsPluginMiddleware(this.projectRoot, this.devToolsPluginManager).getHandler()
      );

      const deepLinkMiddleware = new RuntimeRedirectMiddleware(this.projectRoot, {
        onDeepLink: getDeepLinkHandler(this.projectRoot),
        getLocation: ({ runtime }) => {
          if (runtime === 'custom') {
            return this.urlCreator?.constructDevClientUrl();
          } else {
            return this.urlCreator?.constructUrl({
              scheme: 'exp',
            });
          }
        },
      });
      middleware.use(deepLinkMiddleware.getHandler());

      middleware.use(new CreateFileMiddleware(this.projectRoot).getHandler());

      // Append support for redirecting unhandled requests to the index.html page on web.
      if (this.isTargetingWeb()) {
        // This MUST be after the manifest middleware so it doesn't have a chance to serve the template `public/index.html`.
        middleware.use(new ServeStaticMiddleware(this.projectRoot).getHandler());

        // This should come after the static middleware so it doesn't serve the favicon from `public/favicon.ico`.
        middleware.use(new FaviconMiddleware(this.projectRoot).getHandler());

        let rscPathPrefix = rscPath;
        if (rscPathPrefix !== '/') {
          rscPathPrefix += '/';
        }

        const rscMiddleware = createRscDevMiddleware(this.projectRoot, {
          getServerUrl: () => {
            return this.getDevServerUrlOrAssert();
          },
          instanceMetroOptions: this.instanceMetroOptions,
          rscPath,
          ssrLoadModule: this.ssrLoadModule.bind(this),
        });

        this.onReloadRscEvent = rscMiddleware.onReloadRscEvent;
        middleware.use(rscMiddleware.middleware);

        if (useServerRendering) {
          middleware.use(
            createRouteHandlerMiddleware(this.projectRoot, {
              appDir,
              routerRoot,
              config,
              ...config.exp.extra?.router,
              bundleApiRoute: (functionFilePath) =>
                this.ssrImportApiRoute(functionFilePath, { platform: 'web' }),
              getStaticPageAsync: (pathname) => {
                return this.getStaticPageAsync(pathname);
              },
            })
          );

          observeAnyFileChanges(
            {
              metro,
              server,
            },
            (events) => {
              if (exp.web?.output === 'server') {
                // NOTE(EvanBacon): We aren't sure what files the API routes are using so we'll just invalidate
                // aggressively to ensure we always have the latest. The only caching we really get here is for
                // cases where the user is making subsequent requests to the same API route without changing anything.
                // This is useful for testing but pretty suboptimal. Luckily our caching is pretty aggressive so it makes
                // up for a lot of the overhead.
                this.invalidateApiRouteCache();
              } else if (!hasWarnedAboutApiRoutes()) {
                for (const event of events) {
                  if (
                    // If the user did not delete a file that matches the Expo Router API Route convention, then we should warn that
                    // API Routes are not enabled in the project.
                    event.metadata?.type !== 'd' &&
                    // Ensure the file is in the project's routes directory to prevent false positives in monorepos.
                    event.filePath.startsWith(appDir) &&
                    isApiRouteConvention(event.filePath)
                  ) {
                    warnInvalidWebOutput();
                  }
                }
              }
            }
          );
        } else {
          // This MUST run last since it's the fallback.
          middleware.use(
            new HistoryFallbackMiddleware(manifestMiddleware.getHandler().internal).getHandler()
          );
        }
      }
    }
    // Extend the close method to ensure that we clean up the local info.
    const originalClose = server.close.bind(server);

    server.close = (callback?: (err?: Error) => void) => {
      return originalClose((err?: Error) => {
        this.instance = null;
        this.metro = null;
        this.hmrServer = null;
        this.ssrHmrClients = new Map();
        callback?.(err);
      });
    };

    assertMetroPrivateServer(metro);
    this.metro = metro;
    this.hmrServer = hmrServer;
    return {
      server,
      location: {
        // The port is the main thing we want to send back.
        port: options.port,
        // localhost isn't always correct.
        host: 'localhost',
        // http is the only supported protocol on native.
        url: `http://localhost:${options.port}`,
        protocol: 'http',
      },
      middleware,
      messageSocket,
    };
  }

  private onReloadRscEvent: (() => void) | null = null;

  private async registerSsrHmrAsync(url: string, onReload: () => void) {
    if (!this.hmrServer || this.ssrHmrClients.has(url)) {
      return;
    }

    console.log('Register SSR HMR:', url);

    const sendFn = (message: string) => {
      const data = JSON.parse(String(message)) as { type: string; body: any };

      switch (data.type) {
        case 'bundle-registered':
        case 'update-done':
        case 'update-start':
          break;
        case 'update':
          const update = data.body;
          const {
            isInitialUpdate,
            added,
            modified,
            deleted,
          }: {
            isInitialUpdate?: boolean;
            added: unknown[];
            modified: unknown[];
            deleted: unknown[];
          } = update;

          const hasUpdate = added.length || modified.length || deleted.length;

          // NOTE: We throw away the updates and instead simply send a trigger to the client to re-fetch the server route.
          if (!isInitialUpdate && hasUpdate) {
            onReload();
          }
          break;
        case 'error':
          // GraphNotFound can mean that we have an issue in metroOptions where the URL doesn't match the object props.
          console.log('HMR Error:', data);
          // @ts-expect-error
          console.log('Available keys:', (this.metro?._bundler._revisionsByGraphId as Map).keys());
          break;
        default:
          debug('Unknown HMR message:', data);
          break;
      }
    };

    const client = await this.hmrServer!.onClientConnect(url, sendFn);
    this.ssrHmrClients.set(url, client);
    // Opt in...
    client.optedIntoHMR = true;
    await this.hmrServer!._registerEntryPoint(client, url, sendFn);
  }

  private ssrHmrClients: Map<string, import('metro/src/HmrServer').Client> = new Map();

  public async waitForTypeScriptAsync(): Promise<boolean> {
    if (!this.instance) {
      throw new Error('Cannot wait for TypeScript without a running server.');
    }

    return new Promise<boolean>((resolve) => {
      if (!this.metro) {
        // This can happen when the run command is used and the server is already running in another
        // process. In this case we can't wait for the TypeScript check to complete because we don't
        // have access to the Metro server.
        debug('Skipping TypeScript check because Metro is not running (headless).');
        return resolve(false);
      }

      const off = metroWatchTypeScriptFiles({
        projectRoot: this.projectRoot,
        server: this.instance!.server,
        metro: this.metro,
        tsconfig: true,
        throttle: true,
        eventTypes: ['change', 'add'],
        callback: async () => {
          // Run once, this prevents the TypeScript project prerequisite from running on every file change.
          off();
          const { TypeScriptProjectPrerequisite } = await import(
            '../../doctor/typescript/TypeScriptProjectPrerequisite.js'
          );

          try {
            const req = new TypeScriptProjectPrerequisite(this.projectRoot);
            await req.bootstrapAsync();
            resolve(true);
          } catch (error: any) {
            // Ensure the process doesn't fail if the TypeScript check fails.
            // This could happen during the install.
            Log.log();
            Log.error(
              chalk.red`Failed to automatically setup TypeScript for your project. Try restarting the dev server to fix.`
            );
            Log.exception(error);
            resolve(false);
          }
        },
      });
    });
  }

  public async startTypeScriptServices() {
    return startTypescriptTypeGenerationAsync({
      server: this.instance?.server,
      metro: this.metro,
      projectRoot: this.projectRoot,
    });
  }

  protected getConfigModuleIds(): string[] {
    return ['./metro.config.js', './metro.config.json', './rn-cli.config.js'];
  }

  // API Routes

  private pendingRouteOperations = new Map<
    string,
    Promise<{ src: string; filename: string; map: string } | null>
  >();

  // Bundle the API Route with Metro and return the string contents to be evaluated in the server.
  private async bundleApiRoute(
    filePath: string,
    { platform }: { platform: string }
  ): Promise<{ src: string; filename: string; map?: any } | null | undefined> {
    if (this.pendingRouteOperations.has(filePath)) {
      return this.pendingRouteOperations.get(filePath);
    }
    const bundleAsync = async () => {
      try {
        debug('Bundle API route:', this.instanceMetroOptions.routerRoot, filePath);
        return await this.ssrLoadModuleContents(filePath, {
          // TODO: This isn't right!
          environment: 'react-server',
          isExporting: true,
          platform,
        });
      } catch (error: any) {
        const appDir = this.instanceMetroOptions?.routerRoot
          ? path.join(this.projectRoot, this.instanceMetroOptions!.routerRoot!)
          : undefined;
        const relativePath = appDir ? path.relative(appDir, filePath) : filePath;

        // Expected errors: invalid syntax, missing resolutions.
        // Wrap with command error for better error messages.
        const err = new CommandError(
          'API_ROUTE',
          chalk`Failed to bundle API Route: {bold ${relativePath}}\n\n` + error.message
        );

        for (const key in error) {
          // @ts-expect-error
          err[key] = error[key];
        }

        throw err;
      } finally {
        // pendingRouteOperations.delete(filepath);
      }
    };
    const route = bundleAsync();

    this.pendingRouteOperations.set(filePath, route);
    return route;
  }

  private async ssrImportApiRoute(
    filePath: string,
    { platform }: { platform: string }
  ): Promise<null | Record<string, Function> | Response> {
    // TODO: Cache the evaluated function.
    try {
      const apiRoute = await this.bundleApiRoute(filePath, { platform });

      if (!apiRoute?.src) {
        return null;
      }
      return evalMetroNoHandling(this.projectRoot, apiRoute.src, apiRoute.filename);
    } catch (error) {
      // Format any errors that were thrown in the global scope of the evaluation.
      if (error instanceof Error) {
        try {
          const htmlServerError = await getErrorOverlayHtmlAsync({
            error,
            projectRoot: this.projectRoot,
            routerRoot: this.instanceMetroOptions.routerRoot!,
          });

          return new Response(htmlServerError, {
            status: 500,
            headers: {
              'Content-Type': 'text/html',
            },
          });
        } catch (internalError) {
          debug('Failed to generate Metro server error UI for API Route error:', internalError);
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  private invalidateApiRouteCache() {
    this.pendingRouteOperations.clear();
  }

  // Metro HMR

  private setupHmr(url: URL) {
    const onReload = () => {
      // Send reload command to client from Fast Refresh code.
      console.log('[CLI]: Reload RSC');

      this.onReloadRscEvent?.();
      // NOTE: We cannot clear the renderer context because it would break the mounted context state.

      this.broadcastMessage('sendDevCommand', {
        name: 'rsc-reload',
        // TODO: Target only certain platforms
        // platform,
      });
    };

    this.registerSsrHmrAsync(url.toString(), onReload);
  }

  // Direct Metro access

  // Emulates the Metro dev server .bundle endpoint without having to go through a server.
  private async _bundleDirectAsync(
    resolvedEntryFilePath: string,
    {
      transformOptions,
      resolverOptions,
      graphOptions,
      serializerOptions,
    }: {
      transformOptions: TransformInputOptions;
      resolverOptions: {
        customResolverOptions: CustomResolverOptions;
        dev: boolean;
      };
      serializerOptions: {
        modulesOnly: boolean;
        runModule: boolean;
        sourceMapUrl: string;
        sourceUrl: string;
        inlineSourceMap: boolean;
        excludeSource: boolean;
      };
      graphOptions: {
        shallow: boolean;
        lazy: boolean;
      };
    }
  ): Promise<{
    numModifiedFiles: number;
    lastModifiedDate: Date;
    nextRevId: string;
    bundle: string;
    map: string;

    // Defined if the output is multi-bundle.
    artifacts?: SerialAsset[];
    assets?: readonly BundleAssetWithFileHashes[];
  }> {
    assert(this.metro, 'Metro server must be running to bundle directly.');
    const config = this.metro._config;
    const buildNumber = this.metro.getNewBuildNumber();
    const bundlePerfLogger = config.unstable_perfLoggerFactory?.('BUNDLING_REQUEST', {
      key: buildNumber,
    });

    const onProgress: MetroOnProgress = (transformedFileCount: number, totalFileCount: number) => {
      this.metro?._reporter?.update?.({
        buildID: getBuildID(buildNumber),
        type: 'bundle_transform_progressed',
        transformedFileCount,
        totalFileCount,
      });
    };

    const revPromise = this.getMetroRevision(resolvedEntryFilePath, {
      graphOptions,
      transformOptions,
      resolverOptions,
    });

    bundlePerfLogger?.point('resolvingAndTransformingDependencies_start');
    bundlePerfLogger?.annotate({
      bool: {
        initial_build: revPromise == null,
      },
    });
    this.metro?._reporter.update({
      buildID: getBuildID(buildNumber),
      bundleDetails: {
        bundleType: transformOptions.type,
        dev: transformOptions.dev,
        entryFile: resolvedEntryFilePath,
        minify: transformOptions.minify,
        platform: transformOptions.platform,
        // @ts-expect-error: typed incorrectly upstream
        customResolverOptions: resolverOptions.customResolverOptions,
        customTransformOptions: transformOptions.customTransformOptions,
      },
      isPrefetch: false,
      type: 'bundle_build_started',
    });

    try {
      const { delta, revision } = await (revPromise != null
        ? this.metro.getBundler().updateGraph(await revPromise, false)
        : this.metro.getBundler().initializeGraph(
            // NOTE: Using absolute path instead of relative input path is a breaking change.
            // entryFile,
            resolvedEntryFilePath,

            transformOptions,
            resolverOptions,
            {
              onProgress,
              shallow: graphOptions.shallow,
              // @ts-expect-error: typed incorrectly
              lazy: graphOptions.lazy,
            }
          ));
      bundlePerfLogger?.annotate({
        int: {
          graph_node_count: revision.graph.dependencies.size,
        },
      });
      bundlePerfLogger?.point('resolvingAndTransformingDependencies_end');
      bundlePerfLogger?.point('serializingBundle_start');

      const shouldAddToIgnoreList = this.metro._shouldAddModuleToIgnoreList.bind(this.metro);

      const serializer = this.getMetroSerializer();

      const bundle = await serializer(
        // NOTE: Using absolute path instead of relative input path is a breaking change.
        // entryFile,
        resolvedEntryFilePath,

        revision.prepend as any,
        revision.graph as any,
        {
          asyncRequireModulePath: await this.metro._resolveRelativePath(
            config.transformer.asyncRequireModulePath,
            {
              relativeTo: 'project',
              resolverOptions,
              transformOptions,
            }
          ),
          // ...serializerOptions,
          processModuleFilter: config.serializer.processModuleFilter,
          createModuleId: this.metro._createModuleId,
          getRunModuleStatement: config.serializer.getRunModuleStatement,
          includeAsyncPaths: graphOptions.lazy,
          dev: transformOptions.dev,
          projectRoot: config.projectRoot,
          modulesOnly: serializerOptions.modulesOnly,
          runBeforeMainModule: config.serializer.getModulesRunBeforeMainModule(
            resolvedEntryFilePath
            // path.relative(config.projectRoot, entryFile)
          ),
          runModule: serializerOptions.runModule,
          sourceMapUrl: serializerOptions.sourceMapUrl,
          sourceUrl: serializerOptions.sourceUrl,
          inlineSourceMap: serializerOptions.inlineSourceMap,
          serverRoot: config.server.unstable_serverRoot ?? config.projectRoot,
          shouldAddToIgnoreList,

          // @ts-expect-error: passed to our serializer to enable non-serial return values.
          serializerOptions,
        }
      );

      this.metro._reporter.update({
        buildID: getBuildID(buildNumber),
        type: 'bundle_build_done',
      });

      bundlePerfLogger?.point('serializingBundle_end');

      let bundleCode: string | null = null;
      let bundleMap: string | null = null;

      // @ts-expect-error: If the output is multi-bundle...
      if (serializerOptions.output === 'static') {
        try {
          const parsed = typeof bundle === 'string' ? JSON.parse(bundle) : bundle;

          assert(
            'artifacts' in parsed && Array.isArray(parsed.artifacts),
            'Expected serializer to return an object with key artifacts to contain an array of serial assets.'
          );

          const artifacts = parsed.artifacts as SerialAsset[];
          const assets = parsed.assets;

          const bundleCode = artifacts.filter((asset) => asset.type === 'js')[0];
          const bundleMap = artifacts.filter((asset) => asset.type === 'map')?.[0]?.source ?? '';

          return {
            numModifiedFiles: delta.reset
              ? delta.added.size + revision.prepend.length
              : delta.added.size + delta.modified.size + delta.deleted.size,
            lastModifiedDate: revision.date,
            nextRevId: revision.id,
            bundle: bundleCode.source,
            map: bundleMap,
            artifacts,
            assets,
          };
        } catch (error: any) {
          throw new Error(
            'Serializer did not return expected format. The project copy of `expo/metro-config` may be out of date. Error: ' +
              error.message
          );
        }
      }

      if (typeof bundle === 'string') {
        bundleCode = bundle;

        // Create the source map in a second pass...
        let { prepend, graph } = revision;
        if (serializerOptions.modulesOnly) {
          prepend = [];
        }

        bundleMap = await sourceMapStringAsync(
          [
            //
            ...prepend,
            ...this.metro._getSortedModules(graph),
          ],
          {
            excludeSource: serializerOptions.excludeSource,
            processModuleFilter: config.serializer.processModuleFilter,
            shouldAddToIgnoreList,
          }
        );
      } else {
        bundleCode = bundle.code;
        bundleMap = bundle.map;
      }

      return {
        numModifiedFiles: delta.reset
          ? delta.added.size + revision.prepend.length
          : delta.added.size + delta.modified.size + delta.deleted.size,
        lastModifiedDate: revision.date,
        nextRevId: revision.id,
        bundle: bundleCode,
        map: bundleMap,
      };
    } catch (error) {
      this.metro._reporter.update({
        buildID: getBuildID(buildNumber),
        type: 'bundle_build_failed',
      });

      throw error;
    }
  }

  private getMetroSerializer() {
    return (
      this.metro?._config?.serializer.customSerializer ||
      ((entryPoint, preModules, graph, options) =>
        bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code)
    );
  }

  private getMetroRevision(
    resolvedEntryFilePath: string,
    {
      graphOptions,
      transformOptions,
      resolverOptions,
    }: {
      transformOptions: TransformInputOptions;
      resolverOptions: {
        customResolverOptions: CustomResolverOptions;
        dev: boolean;
      };
      graphOptions: {
        shallow: boolean;
        lazy: boolean;
      };
    }
  ) {
    assert(this.metro, 'Metro server must be running to bundle directly.');
    const config = this.metro._config;

    const graphId = getGraphId(resolvedEntryFilePath, transformOptions, {
      unstable_allowRequireContext: config.transformer.unstable_allowRequireContext,
      resolverOptions,
      shallow: graphOptions.shallow,
      lazy: graphOptions.lazy,
    });
    return this.metro.getBundler().getRevisionByGraphId(graphId);
  }

  private async resolveRelativePathAsync(
    moduleId: string,
    {
      resolverOptions,
      transformOptions,
    }: {
      transformOptions: TransformInputOptions;
      resolverOptions: {
        customResolverOptions: CustomResolverOptions;
        dev: boolean;
      };
    }
  ) {
    assert(this.metro, 'cannot invoke resolveRelativePathAsync without metro instance');
    return await this.metro._resolveRelativePath(convertPathToModuleSpecifier(moduleId), {
      relativeTo: 'server',
      resolverOptions,
      transformOptions,
    });
  }
}

function getBuildID(buildNumber: number): string {
  return buildNumber.toString(36);
}

export function getDeepLinkHandler(projectRoot: string): DeepLinkHandler {
  return async ({ runtime }) => {
    if (runtime === 'expo') return;
    const { exp } = getConfig(projectRoot);
    await logEventAsync('dev client start command', {
      status: 'started',
      ...getDevClientProperties(projectRoot, exp),
    });
  };
}

const fileURLToFilePath = (fileURL: string) => {
  if (!fileURL.startsWith('file://')) {
    throw new Error('Not a file URL');
  }
  return decodeURI(fileURL.slice('file://'.length));
};

function wrapBundle(str: string) {
  // Skip the metro runtime so debugging is a bit easier.
  // Replace the __r() call with an export statement.
  // Use gm to apply to the last require line. This is needed when the bundle has side-effects.
  return str.replace(/^(__r\(.*\);)$/gm, 'module.exports = $1');
}

async function sourceMapStringAsync(
  modules: readonly import('metro/src/DeltaBundler/types').Module<any>[],
  options: SourceMapGeneratorOptions
): Promise<string> {
  return (await sourceMapGeneratorNonBlocking(modules, options)).toString(undefined, {
    excludeSource: options.excludeSource,
  });
}

type SSRLoadModuleFunc = <T extends Record<string, any>>(
  filePath: string,
  specificOptions?: Partial<ExpoMetroOptions>,
  extras?: { hot?: boolean }
) => Promise<T>;

function createRscDevMiddleware(
  projectRoot: string,
  {
    rscPath,
    instanceMetroOptions,
    ssrLoadModule,
    getServerUrl,
  }: {
    rscPath: string;
    instanceMetroOptions: Partial<ExpoMetroOptions>;
    ssrLoadModule: SSRLoadModuleFunc;
    getServerUrl: () => string;
  }
) {
  const rscMiddleware = getRscMiddleware({
    config: {},
    // Disabled in development
    baseUrl: '',
    rscPath,
    renderRsc: async (args) => {
      // Dev server-only implementation.
      try {
        return await renderRscToReadableStream({
          ...args,
          body: args.body!,
        });
      } catch (error: any) {
        // If you get a codeFrame error during SSR like when using a Class component in React Server Components, then this
        // will throw with:
        // {
        //   rawObject: {
        //     type: 'TransformError',
        //     lineNumber: 0,
        //     errors: [ [Object] ],
        //     name: 'SyntaxError',
        //     message: '...',
        //   }
        // }

        // TODO: Revisit all error handling now that we do direct metro bundling...

        await logMetroError(projectRoot, { error });

        const sanitizedServerMessage = stripAnsi(error.message) ?? error.message;
        throw new Response(sanitizedServerMessage, {
          status: 500,
          headers: {
            'Content-Type': 'text/plain',
          },
        });
      }
    },
  });

  let rscPathPrefix = rscPath;
  if (rscPathPrefix !== '/') {
    rscPathPrefix += '/';
  }

  async function getExpoRouterRscEntriesGetterAsync({ platform }: { platform: string }) {
    return ssrLoadModule<typeof import('expo-router/build/rsc/router/expo-definedRouter')>(
      resolveFrom(projectRoot, 'expo-router/src/rsc/router/expo-definedRouter.ts'),
      {
        environment: 'react-server',
        platform,
      },
      {
        hot: true,
      }
    );
  }

  function getResolveClientEntry(context: { platform: string; engine?: 'hermes' | null }) {
    // TODO: Memoize this
    const serverRoot = getMetroServerRoot(projectRoot);

    const {
      mode,
      minify = false,
      isExporting,
      baseUrl,
      routerRoot,
      asyncRoutes,
      preserveEnvVars,
      reactCompiler,
      lazy,
    } = instanceMetroOptions;

    assert(
      isExporting != null &&
        baseUrl != null &&
        mode != null &&
        routerRoot != null &&
        asyncRoutes != null,
      `The server must be started. (isExporting: ${isExporting}, baseUrl: ${baseUrl}, mode: ${mode}, routerRoot: ${routerRoot}, asyncRoutes: ${asyncRoutes})`
    );

    return (file: string) => {
      const searchParams = createBundleUrlSearchParams({
        mainModuleName: '',
        platform: context.platform,
        mode,
        minify,
        lazy,
        preserveEnvVars,
        asyncRoutes,
        baseUrl,
        routerRoot,
        isExporting,
        reactCompiler: !!reactCompiler,

        // TODO:
        engine: context.engine ?? undefined,
        bytecode: false,
        clientBoundaries: [],
        inlineSourceMap: false,
      });

      searchParams.set('dev', String(__DEV__));
      // searchParams.set('transform.rscPath', process.env.EXPO_RSC_PATH);
      searchParams.set('resolver.clientboundary', String(true));
      searchParams.set('modulesOnly', String(true));
      searchParams.set('runModule', String(false));

      const clientReferenceUrl = new URL(getServerUrl());
      // [...searchParams.keys()].forEach((key) => {
      //   if (
      //     !['minify', 'transform.engine', 'transform.routerRoot', 'transform.baseUrl'].includes(key)
      //   ) {
      //     searchParams.delete(key);
      //   }
      // });
      // TICKLE: Handshake 1
      searchParams.set('xRSC', '1');

      clientReferenceUrl.search = searchParams.toString();

      const filePath = file.startsWith('file://') ? fileURLToFilePath(file) : file;
      const relativeFilePath = path.relative(serverRoot, filePath);
      // TODO: May need to remove the original extension.
      clientReferenceUrl.pathname = relativeFilePath; //+ '.bundle';

      // Ensure url.pathname ends with '.bundle'
      if (!clientReferenceUrl.pathname.endsWith('.bundle')) {
        clientReferenceUrl.pathname += '.bundle';
      }

      // Return relative URLs to help Android fetch from wherever it was loaded from since it doesn't support localhost.
      const id = clientReferenceUrl.pathname + clientReferenceUrl.search; // + clientReferenceUrl.hash;

      return { id: relativeFilePath, url: [id] };
    };
  }

  const rscRendererCache = new Map<string, typeof import('expo-router/src/rsc/rsc-renderer')>();

  async function getRscRendererAsync(platform: string) {
    // NOTE(EvanBacon): We memoize this now that there's a persistent server storage cache for Server Actions.
    if (rscRendererCache.has(platform)) {
      return rscRendererCache.get(platform)!;
    }

    // TODO: Extract CSS Modules / Assets from the bundler process
    const renderer = await ssrLoadModule<typeof import('expo-router/src/rsc/rsc-renderer')>(
      'expo-router/src/rsc/rsc-renderer.ts',
      {
        environment: 'react-server',
        platform,
      },
      {
        // hot: true,
      }
    );

    rscRendererCache.set(platform, renderer);
    return renderer;
  }

  const rscRenderContext = new Map<string, any>();

  function getRscRenderContext(platform: string) {
    // NOTE(EvanBacon): We memoize this now that there's a persistent server storage cache for Server Actions.
    if (rscRenderContext.has(platform)) {
      return rscRenderContext.get(platform)!;
    }

    const context = {};

    rscRenderContext.set(platform, context);
    return context;
  }

  async function renderRscToReadableStream(
    {
      input,
      searchParams,
      method,
      platform,
      body,
      engine,
      contentType,
    }: {
      input: string;
      searchParams: URLSearchParams;
      method: 'POST' | 'GET';
      platform: string;
      body?: ReadableStream<Uint8Array>;
      engine?: 'hermes' | null;
      contentType?: string;
    },
    isExporting: boolean | undefined = instanceMetroOptions.isExporting
  ) {
    // const { isExporting } = this.instanceMetroOptions;
    assert(isExporting != null, 'The server must be started before calling ssrLoadModule.');

    if (method === 'POST') {
      assert(body, 'Server request must be provided when method is POST (server actions)');
    }

    const { renderRsc } = await getRscRendererAsync(platform);

    // TODO: Add config
    const config = {};
    const context = getRscRenderContext(platform);

    const universalProps = {
      body,
      searchParams,
      context,
      config,
      method,
      input,
      contentType,
    };

    const pipe = await renderRsc(
      {
        ...universalProps,
      },
      {
        isExporting: false,
        entries: await getExpoRouterRscEntriesGetterAsync({ platform }),
        resolveClientEntry: getResolveClientEntry({ platform, engine }),
      }
    );

    return pipe;
  }

  return {
    middleware: createBuiltinAPIRequestHandler(
      // Match `/_flight/[...path]`
      (req) => {
        return getFullUrl(req.url).pathname.startsWith(rscPathPrefix);
      },
      rscMiddleware
    ),
    onReloadRscEvent: () => {
      // NOTE: We cannot clear the renderer context because it would break the mounted context state.

      // Clear the render context to ensure that the next render is a fresh start.
      rscRenderContext.clear();
    },
  };
}

const getFullUrl = (url: string) => {
  try {
    return new URL(url);
  } catch (error: any) {
    if (error.code === 'ERR_INVALID_URL') {
      return new URL(url, 'http://localhost:0');
    }
    throw error;
  }
};

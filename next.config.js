const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');
const webpack = require('webpack');

// Real location of the Cesium package (pnpm keeps packages in a virtual store under node_modules/.pnpm)
const cesiumPath = path.dirname(require.resolve('cesium/package.json'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The deployed site leaves out the sites marked localOnly in landmarks.json (src/data/sites.ts). Vercel's builds
  // set VERCEL=1; a build on a developer's machine shows every site.
  env: {
    NEXT_PUBLIC_HIDE_LOCAL_ONLY_SITES: process.env.VERCEL === '1' ? '1' : '',
  },
  webpack: (config, { isServer }) => {
    // Cesium references these Node modules; there's nothing to load for them in the browser
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false, http: false, https: false, zlib: false, url: false
    };

    // Tell Cesium where its workers and assets are served from (see the copy step below)
    config.plugins.push(
      new webpack.DefinePlugin({
        CESIUM_BASE_URL: JSON.stringify('/cesium')
      })
    );

    // On Vercel's builds the localOnly sites are also dropped from the bundled site list itself, so their positions
    // and file names aren't shipped to visitors (src/data/sites.ts then has nothing left to hide)
    if (process.env.VERCEL === '1') {
      config.module.rules.push({
        test: /src[\\/]data[\\/]landmarks\.json$/,
        type: 'json',
        parser: { parse: (source) => JSON.parse(source).filter((site) => !site.localOnly) },
      });
    }

    config.resolve.alias = {
      ...config.resolve.alias,
      cesium: cesiumPath,
      // Cesium's loader for SPZ splat tiles, which this site never uses. Its embedded WebAssembly gets turned
      // into invalid JavaScript by the production minifier ("Octal escape sequences are not allowed in
      // template strings"), and then Cesium itself fails to load.
      '@spz-loader/core': false,
    };

    // Copy Cesium's workers, widgets and static assets into public/cesium (gitignored). Only the client
    // compilation needs to do it; the server compilation would copy the same files again.
    if (!isServer) {
      config.plugins.push(
        new CopyWebpackPlugin({
          patterns: [
            { from: path.join(cesiumPath, 'Build/Cesium/Workers'), to: path.join(__dirname, 'public/cesium/Workers') },
            { from: path.join(cesiumPath, 'Build/Cesium/ThirdParty'), to: path.join(__dirname, 'public/cesium/ThirdParty') },
            { from: path.join(cesiumPath, 'Build/Cesium/Assets'), to: path.join(__dirname, 'public/cesium/Assets') },
            { from: path.join(cesiumPath, 'Build/Cesium/Widgets'), to: path.join(__dirname, 'public/cesium/Widgets') },
          ],
        })
      );
    }

    return config;
  },
  async headers() {
    return [
      {
        // Cesium's assets only change when Cesium is upgraded
        source: '/cesium/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;

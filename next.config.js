const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');
const webpack = require('webpack');

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config, { dev, isServer }) => {
    // Find Cesium package path (works with npm, yarn, or pnpm)
    const cesiumPath = path.dirname(require.resolve('cesium/package.json'));
    
    // Fallbacks and aliases remain the same
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false, http: false, https: false, zlib: false, url: false
    };
    
    config.plugins.push(
      new webpack.DefinePlugin({
        CESIUM_BASE_URL: JSON.stringify('/cesium')
      })
    );
    
    config.resolve.alias = {
      ...config.resolve.alias,
      cesium: cesiumPath,
    };

    // Only copy assets in production or server builds
    if (!dev || isServer) {
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
  experimental: {
    externalDir: true,
  },
};

module.exports = nextConfig;
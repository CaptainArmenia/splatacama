const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');
const webpack = require('webpack');

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    domains: [
      'nkzhettcqvmytil5.public.blob.vercel-storage.com',
      'vercel-storage.com',
      'public.blob.vercel-storage.com'
    ],
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
  // Configure CORS headers instead
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version',
          },
        ],
      },
      {
        // Specific headers for splat files to prevent timeouts
        source: '/splats/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400',
          }
        ],
      },
    ];
  },
  transpilePackages: ['cesium'],
};

module.exports = nextConfig;
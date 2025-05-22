const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');
const webpack = require('webpack');

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: [
      'nkzhettcqvmytil5.public.blob.vercel-storage.com',
      'vercel-storage.com',
      'public.blob.vercel-storage.com'
    ],
  },
  webpack: (config, { dev, isServer }) => {
    // Find Cesium package path specifically for pnpm
    let cesiumPath;
    try {
      // This will handle pnpm's virtual store path resolution
      cesiumPath = path.dirname(require.resolve('cesium/package.json'));
    } catch (e) {
      console.warn("Failed to resolve Cesium directly. Trying alternative resolution for pnpm...");
      // Fallback for pnpm - try to locate in node_modules/.pnpm
      try {
        const glob = require('glob');
        const cesiumPaths = glob.sync('**/node_modules/.pnpm/cesium@*/node_modules/cesium');
        if (cesiumPaths.length > 0) {
          cesiumPath = path.resolve(cesiumPaths[0]);
        } else {
          throw new Error('Could not find Cesium in pnpm store');
        }
      } catch (err) {
        console.error('Failed to resolve Cesium path:', err);
        cesiumPath = 'cesium'; // Fallback, might not work
      }
    }
    
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

    // Always copy assets regardless of dev or isServer to ensure they're available
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

    return config;
  },
  experimental: {
    externalDir: true,
  },
  // Configure headers for Cross-Origin Isolation to support SharedArrayBuffer
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
          // Cross-Origin Isolation headers
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless', // Changed from require-corp to credentialless
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
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
          },
          // Add Cross-Origin Isolation headers for splat files too
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless', // Changed from require-corp to credentialless
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
        ],
      },
      {
        // Headers for image files
        source: '/:path*.(jpg|jpeg|png|webp|svg|gif)',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
          {
            key: 'Timing-Allow-Origin',
            value: '*',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
        ],
      },
      {
        // Add specific headers for Cesium assets
        source: '/cesium/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'cross-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
          // Add Cache-Control for Cesium assets
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400',
          },
        ],
      },
    ];
  },
  transpilePackages: ['cesium'],
};

module.exports = nextConfig;
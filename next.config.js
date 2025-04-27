/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['example.com'], // Replace with your actual image domains
    // Or use remotePatterns for more specific control
    // remotePatterns: [
    //   {
    //     protocol: 'https',
    //     hostname: 'example.com',
    //     pathname: '/previews/**',
    //   },
    // ],
  },
};

module.exports = nextConfig;

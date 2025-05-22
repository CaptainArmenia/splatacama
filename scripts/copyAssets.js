const fs = require('fs-extra');
const path = require('path');

// Get the Cesium path from node_modules
const cesiumPath = path.join(__dirname, '../node_modules/cesium/Build/Cesium');
const cesiumPublicPath = path.join(__dirname, '../public/cesium');

// Ensure the destination directory exists
fs.ensureDirSync(cesiumPublicPath);

// Copy all Cesium assets to the public directory
fs.copySync(cesiumPath, cesiumPublicPath, {
  filter: (src) => !src.includes('node_modules')
});


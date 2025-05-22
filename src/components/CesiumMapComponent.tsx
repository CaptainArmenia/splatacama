'use client';
// Import React using the default import syntax
import React from 'react';
// Then import individual hooks separately
import { useState, useRef, useEffect } from 'react';
import { loadCesium } from '@/utils/cesiumLoader';
import CesiumCompass from './CesiumCompass';
import {
  Cartesian3,
  HeightReference,
  HorizontalOrigin,
  VerticalOrigin,
} from 'cesium';
import { getBlobUrl } from '@/utils/blobUtils';

interface MapLandmark {
  id: string;
  name: string;
  lat: number;   // Changed from x to lat
  lng: number;   // Changed from y to lng
  height: number; // Added height property
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
}

interface CesiumMapProps {
  landmarks: MapLandmark[];
  humboldtCenter: { lat: number; lng: number };
  selectedLandmark: MapLandmark | null;
  setSelectedLandmark: (landmark: MapLandmark | null) => void;
  setErrorState: (error: string | null) => void;
  showCameraPosition: boolean; // Add this new prop
  preventPinOcclusion: boolean; // New prop
}

// Define default camera configuration - consolidated settings for initial view and reset
const DEFAULT_CAMERA_CONFIG = {
  position: {
    height: 10800, // Height in meters
  },
  orientation: {
    heading: 34,    // North (in degrees, will be converted to radians)
    pitch: -30,    // 10-degree inclination (in degrees, will be converted to radians)
    roll: 0
  },
  animation: {
    duration: 2   // Animation duration in seconds (for reset only)
  }
};

// Update constants - remove the SELECTED_MARKER_SIZE to use consistent size
const DEFAULT_MARKER_SIZE = 40;

// Define border styles for different states
type BorderStyle = 'default' | 'hover' | 'selected';

// Helper function to create circular image from preview URL
const createCircularImageCanvas = (
  imageUrl: string, 
  size: number = DEFAULT_MARKER_SIZE,
  borderStyle: BorderStyle = 'default' // Support different border styles
): Promise<HTMLCanvasElement> => {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      reject(new Error('Could not get canvas context'));
      return;
    }
    
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Create circular clipping path
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.clip();
      
      // Draw image
      ctx.drawImage(img, 0, 0, size, size);
      
      // Add border with style based on state
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
      ctx.closePath();
      
      // Apply border style based on state
      switch (borderStyle) {
        case 'selected':
          ctx.lineWidth = 4;
          ctx.strokeStyle = '#00ff4c'; // Green for selected
          break;
        case 'hover':
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = '#ffffff'; // Bright white for hover
          
          // Add glow effect for hover state
          ctx.shadowBlur = 10;
          ctx.shadowColor = '#ffffff';
          break;
        default:
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#FFFFFF'; // Standard white for default
      }
      
      ctx.stroke();
      resolve(canvas);
    };
    
    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };
    
    img.src = imageUrl;
  });
};

// Helper function to create a fallback marker when image loading fails
const createFallbackMarker = (
  size: number = DEFAULT_MARKER_SIZE,
  borderStyle: BorderStyle = 'default' // Support different border styles
): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  
  if (ctx) {
    // Fill circle with orange color
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = '#dd6b20';
    ctx.fill();
    
    // Apply border style based on state
    switch (borderStyle) {
      case 'selected':
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#00ff4c'; // Green for selected
        break;
      case 'hover':
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#ffffff'; // Bright white for hover
        
        // Add glow effect for hover state
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ffffff';
        break;
      default:
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#FFFFFF'; // Standard white for default
    }
    
    ctx.stroke();
  }
  
  return canvas;
};

export default function CesiumMapComponent({
  landmarks,
  humboldtCenter,
  selectedLandmark,
  setSelectedLandmark,
  setErrorState,
  showCameraPosition: initialShowCameraPosition, // Rename to indicate it's initial state
  preventPinOcclusion, // Add this to function params
}: CesiumMapProps) {
  // 1. All useRefs first - maintain consistent order
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const entityRefs = useRef<{[id: string]: any}>({});
  
  // 2. All useState hooks
  const [mapLoaded, setMapLoaded] = useState(false);
  const [cesium, setCesium] = useState<any>(null);
  const [showCameraPosition, setShowCameraPosition] = useState(initialShowCameraPosition);
  const [cameraPosition, setCameraPosition] = useState({
    latitude: 0,
    longitude: 0,
    height: 0,
    heading: 0,
    pitch: 0
  });
  const [landmarkPreviewUrls, setLandmarkPreviewUrls] = useState<{[id: string]: string}>({});
  const [previewUrlsLoading, setPreviewUrlsLoading] = useState<{[id: string]: boolean}>({});
  const [previewUrlsError, setPreviewUrlsError] = useState<{[id: string]: boolean}>({});
  const [markerImages, setMarkerImages] = useState<{[id: string]: HTMLCanvasElement}>({});

  // 3. All useEffect hooks - make sure they're all declared unconditionally
  
  // Load Cesium
  useEffect(() => {
    async function initCesium() {
      try {
        // Only load Cesium on the client side
        const cesiumModule = await import('cesium');
        setCesium(cesiumModule);
      } catch (error) {
        console.error('Failed to load Cesium:', error);
        setErrorState('Error loading 3D map components');
      }
    }
    
    // Check if we're in browser environment
    if (typeof window !== 'undefined') {
      initCesium();
    }
  }, [setErrorState]);

  // Process preview images into circular markers
  useEffect(() => {
    async function processMarkerImages() {
      const markerImagesMap: {[id: string]: HTMLCanvasElement} = {};
      
      for (const landmark of landmarks) {
        if (landmark.previewUrl && landmarkPreviewUrls[landmark.id]) {
          try {
            const canvas = await createCircularImageCanvas(landmarkPreviewUrls[landmark.id]);
            markerImagesMap[landmark.id] = canvas;
          } catch (error) {
            console.error(`Error creating circular image for ${landmark.id}:`, error);
            markerImagesMap[landmark.id] = createFallbackMarker();
          }
        } else {
          markerImagesMap[landmark.id] = createFallbackMarker();
        }
      }
      
      setMarkerImages(markerImagesMap);
    }
    
    if (Object.keys(landmarkPreviewUrls).length > 0) {
      processMarkerImages();
    }
  }, [landmarks, landmarkPreviewUrls]);

  // Create viewer once Cesium is loaded
  useEffect(() => {
    if (!cesium || !containerRef.current) return;

    try {
      // Configure Cesium Ion token with better error handling
      if (!process.env.NEXT_PUBLIC_CESIUM_TOKEN) {
        console.error("Cesium Ion Token is missing. Check .env.local and restart the server.");
        setErrorState("Cesium Ion Token is missing. Please configure it in your environment variables.");
        return; 
      }
      
      // Set the token and configure the default server
      cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN;
      
      // Create Cesium viewer
      const viewer = new cesium.Viewer(containerRef.current, {
        terrain: undefined,
        timeline: false,
        animation: false,
        sceneModePicker: false,  
        baseLayerPicker: true,  // Keep this enabled
        baseLayer: new cesium.ImageryLayer.fromProviderAsync(cesium.IonImageryProvider.fromAssetId(3954)),
        navigationHelpButton: false,
        homeButton: false,       
        geocoder: false,
        fullscreenButton: false,  
        vrButton: false,
        navigationInstructionsInitiallyVisible: false,
        selectionIndicator: false,
        infoBox: false,
        creditContainer: document.createElement('div'), // Hide credits
      });

      // Store viewer reference
      viewerRef.current = viewer;

      // Customize the baseLayerPicker to use a layer icon
      setTimeout(() => {
        try {
          // Find the baseLayerPicker elements
          const baseLayerPickerContainer = document.querySelector('.cesium-viewer .cesium-baseLayerPicker-dropDown');
          const layerButton = document.querySelector('.cesium-viewer .cesium-toolbar-button');
          
          // Reposition the container
          if (baseLayerPickerContainer && baseLayerPickerContainer.parentElement) {
            const container = baseLayerPickerContainer.parentElement;
            Object.assign(container.style, {
              top: '15%',
              right: '20px',
              position: 'absolute',
              zIndex: '35',
              transition: 'transform 0.3s ease-in-out',
            });
          }

          // Replace the default button with a custom layer icon
          if (layerButton) {
            const button = layerButton as HTMLElement;
            
            // Set button dimensions and style
            Object.assign(button.style, {
              width: '50px',
              height: '50px',
              background: 'rgba(0, 0, 0, 0.6)',
              border: '2px solid rgba(255, 255, 255, 0.3)',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0',
              transition: 'all 0.2s ease',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
            });
            
            // Add hover effect
            button.onmouseenter = () => {
              button.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
              button.style.transform = 'translateY(-2px)';
              button.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
            };
            
            button.onmouseleave = () => {
              button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
              button.style.transform = 'translateY(0)';
              button.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
            };
            
            // Clear existing content and add custom SVG icon
            button.innerHTML = '';
            const layerIcon = document.createElement('div');
            layerIcon.innerHTML = `
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                <path d="M2 17l10 5 10-5"></path>
                <path d="M2 12l10 5 10-5"></path>
              </svg>
            `;
            button.appendChild(layerIcon);
            
            // Add tooltip/label
            const tooltip = document.createElement('span');
            tooltip.textContent = 'Cambiar mapa';
            tooltip.style.cssText = 'position: absolute; background: rgba(0,0,0,0.8); color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; white-space: nowrap; opacity: 0; transition: opacity 0.2s ease; right: 60px;';
            
            button.appendChild(tooltip);
            
            button.onmouseenter = (e) => {
              button.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
              button.style.transform = 'translateY(-2px)';
              button.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
              tooltip.style.opacity = '1';
            };
            
            button.onmouseleave = (e) => {
              button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
              button.style.transform = 'translateY(0)';
              button.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
              tooltip.style.opacity = '0';
            };
          }

        } catch (error) {
          console.warn("Error customizing baseLayerPicker:", error);
        }
      }, 200); // Small delay to ensure DOM is ready
      
      // Load terrain asynchronously
      cesium.createWorldTerrainAsync().then((terrainProvider: any) => {
        viewer.scene.terrainProvider = terrainProvider;
      });
      
      // Set up viewer settings
      viewer.scene.globe.enableLighting = true;
      viewer.scene.globe.depthTestAgainstTerrain = true;
      viewer.scene.globe.terrainExaggeration = 1.5;
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;

      // Additional setting to ensure depth testing works properly
      if (preventPinOcclusion) {
        viewer.scene.globe.depthTestAgainstTerrain = false;
      }

      // Add landmarks as billboards using the processed images when available
      landmarks.forEach((landmark) => {
        const fallbackCanvas = createFallbackMarker();

        const entity = new cesium.Entity({
          position: cesium.Cartesian3.fromDegrees(landmark.lng, landmark.lat, landmark.height || 200),
          name: landmark.name,
          id: landmark.id,
          billboard: {
            image: fallbackCanvas,  // Start with fallback, will update when real image is ready
            width: DEFAULT_MARKER_SIZE,
            height: DEFAULT_MARKER_SIZE,
            heightReference: preventPinOcclusion ? HeightReference.NONE : HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: preventPinOcclusion ? Number.POSITIVE_INFINITY : undefined,
            verticalOrigin: VerticalOrigin.BOTTOM,
            horizontalOrigin: HorizontalOrigin.CENTER,
            scale: 1.0,
          }
        });

        // Store entity reference for later styling updates
        entityRefs.current[landmark.id] = entity;
        viewer.entities.add(entity);
      });

      // Implement custom click handler for smoother selection
      const clickHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((click: any) => {
        // Try to pick an entity at the click position
        const pickedObject = viewer.scene.pick(click.position);
        
        if (cesium.defined(pickedObject) && pickedObject.id) {
          // Entity was clicked
          const clickedEntity = pickedObject.id;
          const clickedLandmark = landmarks.find(landmark => landmark.id === clickedEntity.id);
          
          if (clickedLandmark) {
            // Prevent default zoom behavior
            click.preventDefault?.();
            
            // Set the selected landmark
            setSelectedLandmark(clickedLandmark);
          }
        } else {
          // Clicked empty space - deselect current landmark
          setSelectedLandmark(null);
        }
      }, cesium.ScreenSpaceEventType.LEFT_CLICK);

      // Add hover effect handlers
      const hoverHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      
      // Mouse over handler for hover effect
      hoverHandler.setInputAction((movement: any) => {
        const pickedObject = viewer.scene.pick(movement.endPosition);
        
        if (cesium.defined(pickedObject) && pickedObject.id) {
          const hoveredEntity = pickedObject.id;
          
          // Only apply hover effect if the entity is a landmark (has an id in our landmarks array)
          const isLandmark = landmarks.some(landmark => landmark.id === hoveredEntity.id);
          
          if (isLandmark && hoveredEntity.billboard) {
            // Skip if this is the selected landmark (already has special styling)
            const isSelected = selectedLandmark && selectedLandmark.id === hoveredEntity.id;
            if (!isSelected) {
              // Mark hover active and apply scaling animation
              if (!hoveredEntity._hoverActive) {
                hoveredEntity._hoverActive = true;
                
                // Store original scale to restore later
                if (hoveredEntity.billboard.scale) {
                  hoveredEntity._originalScale = hoveredEntity.billboard.scale.getValue();
                } else {
                  hoveredEntity._originalScale = 1.0;
                }
                
                // Apply scale animation - grow slightly larger on hover
                hoveredEntity.billboard.scale = new cesium.CallbackProperty(() => {
                  // Calculate animated scale value between 1.0 and 1.15
                  const pulseFactor = 1.15;
                  return hoveredEntity._originalScale * pulseFactor;
                }, false);
                
                // Add bright border using a different color with glow effect
                if (markerImages[hoveredEntity.id]) {
                  // Create a copy of the canvas with hover effect
                  createCircularImageCanvas(landmarkPreviewUrls[hoveredEntity.id] || '', DEFAULT_MARKER_SIZE, 'hover')
                    .then(hoverCanvas => {
                      if (hoveredEntity._hoverActive) { // Check if still hovering
                        hoveredEntity.billboard.image = hoverCanvas;
                      }
                    });
                }
              }
            }
          }
        } else {
          // Reset all non-selected landmarks that had hover effects
          viewer.entities.values.forEach((entity: any) => {
            if (entity._hoverActive && entity.billboard && 
                (!selectedLandmark || entity.id !== selectedLandmark.id)) {
              // Remove hover properties and restore original appearance
              entity._hoverActive = false;
              
              // Restore original scale
              if (entity._originalScale !== undefined) {
                entity.billboard.scale = entity._originalScale;
                entity._originalScale = undefined;
              }
              
              // Restore original image if available
              if (markerImages[entity.id]) {
                entity.billboard.image = markerImages[entity.id];
              }
            }
          });
        }
      }, cesium.ScreenSpaceEventType.MOUSE_MOVE);
      
      // Set up resize observer to handle responsive behavior
      const handleResize = () => {
        if (containerRef.current && viewer) {
          // Trigger a resize to update canvas dimensions
          viewer.resize();
          
          // Update camera aspect ratio
          const { width, height } = containerRef.current.getBoundingClientRect();
          viewer.scene.camera.frustum.aspectRatio = width / height;
          
          // Force a scene render to apply changes
          viewer.scene.requestRender();
        }
      };
      
      // Set up resize observer
      const resizeObserver = new ResizeObserver(handleResize);
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }
      
      // Set up initial camera position using the default config
      const centerPoint = cesium.Cartesian3.fromDegrees(
        humboldtCenter.lng, 
        humboldtCenter.lat,
        DEFAULT_CAMERA_CONFIG.position.height
      );
      
      viewer.camera.setView({
        destination: centerPoint,
        orientation: {
          heading: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.heading),
          pitch: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.pitch),
          roll: DEFAULT_CAMERA_CONFIG.orientation.roll
        }
      });
      
      // Mark map as loaded
      setMapLoaded(true);

      // Clean up function
      return () => {
        if (resizeObserver) {
          resizeObserver.disconnect();
        }
        clickHandler.destroy();
        hoverHandler.destroy(); // Clean up hover handler
        if (viewer) {
          viewer.destroy();
        }
      };
    } catch (error) {
      console.error("Error initializing Cesium viewer:", error);
      setErrorState("Failed to initialize 3D map viewer");
    }
    // Remove selectedLandmark from the dependency array to prevent map reloading
  }, [cesium, containerRef, landmarks, humboldtCenter, setErrorState, setSelectedLandmark, preventPinOcclusion]);

  // Update markers when marker images are processed
  useEffect(() => {
    if (!cesium || !viewerRef.current || Object.keys(markerImages).length === 0) return;
    
    // Update each entity with its corresponding marker image
    Object.entries(markerImages).forEach(([id, canvas]) => {
      const entity = entityRefs.current[id];
      if (entity && entity.billboard) {
        entity.billboard.image = canvas;
      }
    });
  }, [markerImages, cesium]);

  // Effect to update landmark appearance when selection changes
  useEffect(() => {
    if (!cesium || !viewerRef.current) return;
    
    // Update the appearance of all landmarks
    Object.entries(entityRefs.current).forEach(([id, entity]) => {
      if (entity && entity.billboard) {
        const isSelected = selectedLandmark && selectedLandmark.id === id;
        
        if (isSelected) {
          // Create selected appearance - with green border but same size
          if (markerImages[id]) {
            // Create circular image with green border - keep same size as default
            createCircularImageCanvas(landmarkPreviewUrls[id] || '', DEFAULT_MARKER_SIZE, 'selected')
              .then(selectedCanvas => {
                // Add green highlight ring
                const ctx = selectedCanvas.getContext('2d');
                if (ctx) {
                  ctx.beginPath();
                  ctx.arc(DEFAULT_MARKER_SIZE/2, DEFAULT_MARKER_SIZE/2, DEFAULT_MARKER_SIZE/2 - 2, 0, Math.PI * 2);
                  ctx.lineWidth = 4;
                  ctx.strokeStyle = '#00ff4c';
                  ctx.stroke();
                }
                
                // Keep the same size but update the image
                entity.billboard.image = selectedCanvas;
                // Don't change width, height or scale to keep consistent size
              })
              .catch(() => {
                // Fallback if image processing fails
                const canvas = createFallbackMarker(DEFAULT_MARKER_SIZE, 'selected');
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.beginPath();
                  ctx.arc(DEFAULT_MARKER_SIZE/2, DEFAULT_MARKER_SIZE/2, DEFAULT_MARKER_SIZE/2 - 2, 0, Math.PI * 2);
                  ctx.lineWidth = 4;
                  ctx.strokeStyle = '#00ff4c';
                  ctx.stroke();
                }
                
                // Update only the image, not the size
                entity.billboard.image = canvas;
              });
          }
          
          // Remove the aim ring if it was previously created
          const aimRingId = `${id}-aim`;
          if (entityRefs.current[aimRingId]) {
            viewerRef.current.entities.remove(entityRefs.current[aimRingId]);
            delete entityRefs.current[aimRingId];
          }
        } else {
          // Regular appearance for non-selected landmarks
          if (markerImages[id]) {
            // Only update the image if needed, preserve other properties
            entity.billboard.image = markerImages[id];
          }
          
          // Remove the aim ring if it exists
          const aimRingId = `${id}-aim`;
          if (entityRefs.current[aimRingId]) {
            viewerRef.current.entities.remove(entityRefs.current[aimRingId]);
            delete entityRefs.current[aimRingId];
          }
        }
      }
    });
  }, [selectedLandmark, cesium, viewerRef, preventPinOcclusion, markerImages, landmarkPreviewUrls]);

  // Clean up aim rings when component unmounts
  useEffect(() => {
    return () => {
      if (viewerRef.current && cesium) {
        Object.entries(entityRefs.current).forEach(([id, entity]) => {
          if (id.endsWith('-aim')) {
            viewerRef.current.entities.remove(entity);
          }
        });
      }
    };
  }, [cesium]);

  // Separate useEffect for camera position tracking
  useEffect(() => {
    if (!showCameraPosition || !viewerRef.current || !cesium) return;
    
    const viewer = viewerRef.current;
    
    const updateCameraPosition = () => {
      const camera = viewer.camera;
      const position = camera.positionCartographic;
      
      setCameraPosition({
        latitude: cesium.Math.toDegrees(position.latitude),
        longitude: cesium.Math.toDegrees(position.longitude),
        height: position.height,
        heading: cesium.Math.toDegrees(camera.heading),
        pitch: cesium.Math.toDegrees(camera.pitch)
      });
    };

    // Initial update
    updateCameraPosition();
    
    // Add camera changed event listener
    const cameraMoveEndHandler = viewer.camera.moveEnd.addEventListener(updateCameraPosition);
    
    // Cleanup function
    return () => {
      if (cameraMoveEndHandler) {
        cameraMoveEndHandler();
      }
    };
  }, [showCameraPosition, cesium]);

  // Fetch preview image URLs from Blob storage with better error handling
  useEffect(() => {
    async function fetchPreviewUrls() {
      const previewUrlMap: {[id: string]: string} = {};
      const loadingMap: {[id: string]: boolean} = {};
      const errorMap: {[id: string]: boolean} = {};
      
      for (const landmark of landmarks) {
        if (landmark.previewUrl) {
          try {
            loadingMap[landmark.id] = true;
            const url = await getBlobUrl(landmark.previewUrl);
            
            // Verify the URL is accessible and returns an image
            try {
              const response = await fetch(url, { method: 'HEAD' });
              const contentType = response.headers.get('content-type');
              
              if (response.ok && contentType && contentType.startsWith('image/')) {
                previewUrlMap[landmark.id] = url;
                errorMap[landmark.id] = false;
              } else {
                throw new Error(`Invalid content type: ${contentType}`);
              }
            } catch (fetchError) {
              console.warn(`Error verifying image at ${url}:`, fetchError);
              errorMap[landmark.id] = true;
              
              // Fall back to original URL as last resort
              previewUrlMap[landmark.id] = landmark.previewUrl;
            }
          } catch (error) {
            console.error(`Error fetching preview URL for ${landmark.id}:`, error);
            errorMap[landmark.id] = true;
            previewUrlMap[landmark.id] = landmark.previewUrl; // Fall back to original URL
          } finally {
            loadingMap[landmark.id] = false;
          }
        }
      }
      
      setLandmarkPreviewUrls(previewUrlMap);
      setPreviewUrlsLoading(loadingMap);
      setPreviewUrlsError(errorMap);
    }
    
    fetchPreviewUrls();
  }, [landmarks]);

  // Return loading state or null if Cesium isn't ready
  if (!cesium && typeof window !== 'undefined') {
    return <div>Loading Cesium...</div>; 
  }
  
  if (typeof window === 'undefined') {
    return null; // Return nothing during SSR
  }
  
  return (
    <>
      <div 
        ref={containerRef} 
        className="h-full w-full"
      />
      
      {/* Show loading indicator until fully loaded */}
      {!mapLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-70">
          <div className="text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-orange-500 border-r-transparent align-[-0.125em]" />
            <p className="mt-2">Cargando terreno 3D...</p>
          </div>
        </div>
      )}
      
      {/* Add the custom compass component */}
      {mapLoaded && cesium && viewerRef.current && (
        <CesiumCompass viewer={viewerRef.current} cesium={cesium} />
      )}
      
      {/* Enhanced landmark info panel with preview image - now with consistent dark theme */}
      {selectedLandmark && (
        <div className="absolute top-4 left-4 z-30 bg-gray-900 bg-opacity-90 rounded-md shadow-md border border-gray-700 text-white overflow-hidden max-w-xs md:max-w-sm">
          {/* Close button - positioned absolutely in the corner */}
          <button 
            onClick={() => setSelectedLandmark(null)}
            className="absolute top-2 right-2 z-50 bg-black bg-opacity-60 hover:bg-opacity-80 text-white rounded-full w-7 h-7 flex items-center justify-center transition-colors"
            aria-label="Cerrar"
          >
            <span className="sr-only">Cerrar</span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>

          {/* Preview image at the top - modified with dark theme border */}
          {selectedLandmark.previewUrl && (
            <div className="w-full h-52 relative border-b border-gray-700">
              {previewUrlsLoading[selectedLandmark.id] ? (
                <div className="w-full h-full flex items-center justify-center bg-gray-800">
                  <div className="animate-pulse h-8 w-8 rounded-full border-4 border-orange-500 border-r-transparent" />
                </div>
              ) : previewUrlsError[selectedLandmark.id] ? (
                <div className="w-full h-full flex items-center justify-center bg-gray-800 text-gray-300">
                  <div className="text-center p-4">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 mx-auto mb-2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <p>No se pudo cargar la imagen</p>
                  </div>
                </div>
              ) : (
                <>
                  <img 
                    src={landmarkPreviewUrls[selectedLandmark.id]} 
                    alt={`Vista de ${selectedLandmark.name}`}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      console.error(`Error loading image for ${selectedLandmark.id}`);
                      setPreviewUrlsError(prev => ({...prev, [selectedLandmark.id]: true}));
                    }}
                  />
                  <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-start">
                    <h3 className="font-bold text-xl text-white-400 drop-shadow-md p-4">
                      {selectedLandmark.name}
                    </h3>
                  </div>
                </>
              )}
            </div>
          )}
          
          {/* Content area - now dark themed */}
          <div className="p-3">
            {/* Show title only if no preview image */}
            {!selectedLandmark.previewUrl && (
              <h3 className="font-bold text-lg text-orange-400 mb-2">{selectedLandmark.name}</h3>
            )}
            
            {/* Description */}
            <p className="text-gray-200 text-sm leading-relaxed mb-3">{selectedLandmark.description}</p>
            
            {/* View Scene Button - Styled to match theme */}
            <div className="mt-2">
              <button
                className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors font-medium flex items-center justify-center gap-2 text-sm border border-orange-700"
                onClick={() => {
                  window.location.href = `/scene/${selectedLandmark.id}`;
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                  <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                </svg>
                Ver Escena 3D
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Camera position display panel */}
      {showCameraPosition && (
        <div className="fixed top-4 right-4 z-50 bg-gray-900 bg-opacity-90 p-3 rounded-md shadow-md border border-gray-700 text-white md:absolute md:bottom-4 md:top-auto md:left-4 md:right-auto max-w-[200px]">
          <h3 className="font-bold mb-1 text-orange-400">Posición de la cámara</h3>
          <div className="text-xs space-y-1">
            <p>Lat: <span className="font-mono">{cameraPosition.latitude.toFixed(6)}°</span></p>
            <p>Long: <span className="font-mono">{cameraPosition.longitude.toFixed(6)}°</span></p>
            <p>Altura: <span className="font-mono">{cameraPosition.height.toFixed(2)}m</span></p>
            <p>Dirección: <span className="font-mono">{cameraPosition.heading.toFixed(2)}°</span></p>
            <p>Inclinación: <span className="font-mono">{cameraPosition.pitch.toFixed(2)}°</span></p>
          </div>
        </div>
      )}
      
      {/* Mobile controls - moved to right side for better visibility in all orientations */}
      {mapLoaded && (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2 md:hidden">
          <button 
            className={`w-12 h-12 rounded-full shadow-lg border flex items-center justify-center transition-colors ${
              showCameraPosition 
                ? 'bg-orange-600 text-white border-orange-700' 
                : 'bg-gray-800 bg-opacity-90 text-white border-gray-700'
            }`}
            onClick={() => setShowCameraPosition(prev => !prev)}
            aria-label={showCameraPosition ? 'Ocultar posición' : 'Mostrar posición'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
              <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clipRule="evenodd" />
            </svg>
          </button>
          
          <button 
            className="w-12 h-12 rounded-full shadow-lg bg-gray-800 bg-opacity-90 text-white border border-gray-700 flex items-center justify-center"
            onClick={() => {
              if (viewerRef.current && cesium) {
                try {
                  // Reset view using the same default config
                  const centerPoint = cesium.Cartesian3.fromDegrees(
                    humboldtCenter.lng, 
                    humboldtCenter.lat,
                    DEFAULT_CAMERA_CONFIG.position.height
                  );
                  
                  viewerRef.current.camera.flyTo({
                    destination: centerPoint,
                    orientation: {
                      heading: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.heading),
                      pitch: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.pitch),
                      roll: DEFAULT_CAMERA_CONFIG.orientation.roll
                    },
                    duration: DEFAULT_CAMERA_CONFIG.animation.duration
                  });
                } catch (error) {
                  console.error("Error resetting view:", error);
                }
              }
            }}
            aria-label="Restablecer vista"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-6 h-6">
              <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
      
      {/* Desktop controls - hidden on mobile */}
      {mapLoaded && (
        <>
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10 hidden md:block">
            <button 
              className={`px-3 py-2 rounded-lg shadow-lg text-sm border flex items-center gap-2 transition-colors ${
                showCameraPosition 
                  ? 'bg-orange-600 text-white border-orange-700' 
                  : 'bg-gray-900 bg-opacity-90 text-white border-gray-700 hover:bg-gray-800'
              }`}
              onClick={() => setShowCameraPosition(prev => !prev)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M9.69 18.933l.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 00.281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 103 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 002.273 1.765 11.842 11.842 0 00.976.544l.062.029.018.008.006.003zM10 11.25a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5z" clipRule="evenodd" />
              </svg>
              {showCameraPosition ? 'Ocultar Posición' : 'Mostrar Posición'}
            </button>
          </div>

          <div className="absolute bottom-4 right-4 z-10 hidden md:block">
            <button 
              className="px-3 py-2 rounded-lg shadow-lg text-sm border bg-gray-900 bg-opacity-90 text-white border-gray-700 hover:bg-gray-800 flex items-center gap-2 transition-colors"
              onClick={() => {
                if (viewerRef.current && cesium) {
                  try {
                    // Reset view using the same default config
                    const centerPoint = cesium.Cartesian3.fromDegrees(
                      humboldtCenter.lng, 
                      humboldtCenter.lat,
                      DEFAULT_CAMERA_CONFIG.position.height
                    );
                    
                    viewerRef.current.camera.flyTo({
                      destination: centerPoint,
                      orientation: {
                        heading: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.heading),
                        pitch: cesium.Math.toRadians(DEFAULT_CAMERA_CONFIG.orientation.pitch),
                        roll: DEFAULT_CAMERA_CONFIG.orientation.roll
                      },
                      duration: DEFAULT_CAMERA_CONFIG.animation.duration
                    });
                  } catch (error) {
                    console.error("Error resetting view:", error);
                  }
                }
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
              </svg>
              Restablecer Vista 3D
            </button>
          </div>
        </>
      )}
    </>
  );
}

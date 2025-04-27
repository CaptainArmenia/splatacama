'use client';
import { useState, useRef, useEffect } from 'react';
import landmarks from '@/data/landmarks.json';

// Define interface for our landmark data
interface MapLandmark {
  id: string;
  name: string;
  x: number;
  y: number;
  description: string;
  gsplatUrl: string;
  previewUrl?: string;
}

export default function MapWithPins() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [lastDistance, setLastDistance] = useState<number | null>(null);
  const [lastCenter, setLastCenter] = useState<{ x: number, y: number } | null>(null);

  // Use a different name for our interface and cast with unknown intermediate step
  const typedLandmarks = landmarks as unknown as MapLandmark[];

  const mapImageUrl = "/map.png";

  const calculateBoundaries = () => {
    if (!containerRef.current) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;

    const horizontalLimit = Math.max(0, (containerWidth * scale - containerWidth) / 2);
    const verticalLimit = Math.max(0, (containerHeight * scale - containerHeight) / 2);

    return {
      minX: -horizontalLimit,
      maxX: horizontalLimit,
      minY: -verticalLimit,
      maxY: verticalLimit
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale === 1) return;

    setDragging(true);
    setDragStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging || scale === 1) return;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    const boundaries = calculateBoundaries();

    setPosition({
      x: Math.max(boundaries.minX, Math.min(newX, boundaries.maxX)),
      y: Math.max(boundaries.minY, Math.min(newY, boundaries.maxY))
    });
  };

  const handleMouseUp = () => {
    setDragging(false);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      if (scale === 1) return;

      setDragging(true);
      setDragStart({
        x: e.touches[0].clientX - position.x,
        y: e.touches[0].clientY - position.y
      });
    } else if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      const distance = Math.hypot(
        touch1.clientX - touch2.clientX,
        touch1.clientY - touch2.clientY
      );
      const centerX = (touch1.clientX + touch2.clientX) / 2;
      const centerY = (touch1.clientY + touch2.clientY) / 2;

      setLastDistance(distance);
      setLastCenter({ x: centerX, y: centerY });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();

    if (e.touches.length === 1 && dragging) {
      if (scale === 1) return;

      const newX = e.touches[0].clientX - dragStart.x;
      const newY = e.touches[0].clientY - dragStart.y;

      const boundaries = calculateBoundaries();

      setPosition({
        x: Math.max(boundaries.minX, Math.min(newX, boundaries.maxX)),
        y: Math.max(boundaries.minY, Math.min(newY, boundaries.maxY))
      });
    } else if (e.touches.length === 2 && lastDistance !== null && lastCenter !== null) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      const newDistance = Math.hypot(
        touch1.clientX - touch2.clientX,
        touch1.clientY - touch2.clientY
      );

      const scaleFactor = newDistance / lastDistance;
      const newScale = Math.max(1, Math.min(4, scale * scaleFactor));

      if (Math.abs(newScale - scale) > 0.01) {
        const newCenterX = (touch1.clientX + touch2.clientX) / 2;
        const newCenterY = (touch1.clientY + touch2.clientY) / 2;

        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const centerX = rect.width / 2;
          const centerY = rect.height / 2;

          const oldOffsetX = (lastCenter.x - rect.left - centerX - position.x) / scale;
          const oldOffsetY = (lastCenter.y - rect.top - centerY - position.y) / scale;

          setScale(newScale);

          if (newScale === 1) {
            setPosition({ x: 0, y: 0 });
          } else {
            const newX = newCenterX - rect.left - centerX - oldOffsetX * newScale;
            const newY = newCenterY - rect.top - centerY - oldOffsetY * newScale;

            const boundaries = calculateBoundaries();
            setPosition({
              x: Math.max(boundaries.minX, Math.min(newX, boundaries.maxX)),
              y: Math.max(boundaries.minY, Math.min(newY, boundaries.maxY))
            });
          }
        }

        setLastDistance(newDistance);
        setLastCenter({ x: newCenterX, y: newCenterY });
      }
    }
  };

  const handleTouchEnd = () => {
    setDragging(false);
    setLastDistance(null);
    setLastCenter(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();

    const zoomIn = e.deltaY < 0;

    let newScale;
    if (zoomIn) {
      newScale = Math.min(4, scale + 0.1);
    } else {
      newScale = Math.max(1, scale - 0.1);
    }

    if (newScale !== scale) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const offsetX = (mouseX - centerX - position.x) / scale;
        const offsetY = (mouseY - centerY - position.y) / scale;

        setScale(newScale);

        if (newScale === 1) {
          setPosition({ x: 0, y: 0 });
        } else {
          const newX = mouseX - centerX - offsetX * newScale;
          const newY = mouseY - centerY - offsetY * newScale;

          const boundaries = calculateBoundaries();
          setPosition({
            x: Math.max(boundaries.minX, Math.min(newX, boundaries.maxX)),
            y: Math.max(boundaries.minY, Math.min(newY, boundaries.maxY))
          });
        }
      }
    }
  };

  const handleDoubleClick = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  useEffect(() => {
    if (scale === 1) {
      setPosition({ x: 0, y: 0 });
    } else {
      const boundaries = calculateBoundaries();
      setPosition(prevPosition => ({
        x: Math.max(boundaries.minX, Math.min(prevPosition.x, boundaries.maxX)),
        y: Math.max(boundaries.minY, Math.min(prevPosition.y, boundaries.maxY))
      }));
    }
  }, [scale]);

  useEffect(() => {
    const handleGlobalMouseUp = () => setDragging(false);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative overflow-hidden"
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: '100%',
          height: '100%',
          perspective: '1000px',
          perspectiveOrigin: 'center',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: '0',
            top: '0',
            width: '100%',
            height: '100%',
            transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px)) 
                       scale(${scale})`,
            transformOrigin: 'center',
            cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
            transition: dragging ? 'none' : 'transform 0.1s ease-out',
            touchAction: 'none'
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <img
            src={mapImageUrl}
            alt="Map"
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
            className="select-none"
            draggable={false}
          />
          
          {typedLandmarks.map(landmark => (
            <div
              key={landmark.id}
              style={{
                position: 'absolute',
                left: `${landmark.x}%`,
                top: `${landmark.y}%`,
                width: `${20 / scale}px`,
                height: `${20 / scale}px`,
                backgroundColor: 'rgba(255, 140, 0, 0.8)',
                border: '2px solid white',
                borderRadius: '50%',
                transform: 'translate(-50%, -50%)',
                cursor: 'pointer',
                zIndex: 10,
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                transition: 'background-color 0.2s ease'
              }}
              onClick={(e) => {
                e.stopPropagation();
                window.location.href = `/scene/${landmark.id}`;
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 165, 0, 0.9)';
                e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255, 140, 0, 0.8)';
                e.currentTarget.style.transform = 'translate(-50%, -50%)';
              }}
            >
              <div 
                className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-black bg-opacity-75 text-white text-xs rounded whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                style={{ 
                  opacity: 0,
                  transition: 'opacity 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                {landmark.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

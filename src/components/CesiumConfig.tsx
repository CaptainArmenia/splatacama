'use client';

import { useEffect } from 'react';

export default function CesiumConfig() {
  useEffect(() => {
    import('../utils/cesiumConfig').then(({ initCesium }) => {
      initCesium();
    });
  }, []);
  return null;
}

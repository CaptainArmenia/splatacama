// Global type definitions

// Strengthen React types
/// <reference types="react" />
/// <reference types="react-dom" />

// Next.js types
/// <reference types="next" />
/// <reference types="next/navigation" />
/// <reference types="next/image-types/global" />

// Extend React namespace
declare namespace React {
  interface ReactElement<P = any, T extends string | JSXElementConstructor<any> = string | JSXElementConstructor<any>> {
    type: T;
    props: P;
    key: Key | null;
  }

  type JSXElementConstructor<P> = ((props: P) => ReactElement<any, any> | null) | (new (props: P) => Component<any, any>);
  type Key = string | number;
  
  // Add missing ReactNode definition
  type ReactNode = ReactChild | ReactFragment | ReactPortal | boolean | null | undefined;
  type ReactChild = ReactElement | string | number;
  type ReactFragment = {} | ReactNodeArray;
  type ReactNodeArray = Array<ReactNode>;
  type ReactPortal = any;
}

// Fix Cesium imports
declare module 'cesium' {
  export * from 'cesium/Build/Cesium/Cesium';
}

// Handle JSON imports
declare module '*.json' {
  const value: any;
  export default value;
}

// Handle CSS/SCSS imports
declare module '*.css';
declare module '*.scss';

// Fix Next.js font imports
declare module 'next/font/google' {
  export interface FontOptions {
    weight?: string | string[];
    style?: string | string[];
    subsets?: string[];
    display?: string;
    variable?: string;
    fallback?: string[];
    adjustFontFallback?: boolean;
    preload?: boolean;
  }

  export function Geist(options?: FontOptions): {
    className: string;
    style: { fontFamily: string };
    variable: string;
  };

  export function Geist_Mono(options?: FontOptions): {
    className: string;
    style: { fontFamily: string };
    variable: string;
  };
}

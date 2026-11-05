declare const config: {
  test?: {
    include?: string[];
    exclude?: string[];
    reporters?: string[];
    environment?: string;
    testTimeout?: number;
    hookTimeout?: number;
  };
};

export default config;

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // O MapLibre carrega o próprio worker a partir da pasta dele em node_modules
  optimizeDeps: { exclude: ['maplibre-gl'] },
});

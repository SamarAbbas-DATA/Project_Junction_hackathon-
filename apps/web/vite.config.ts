import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins:[react()], server:{port:5173,strictPort:true,allowedHosts:['amr-junction-demo.loca.lt','grumpy-horse-13.loca.lt'],proxy:{'/api':{target:'http://127.0.0.1:8000',changeOrigin:true}}},build:{rollupOptions:{output:{manualChunks:{charts:['recharts'],query:['@tanstack/react-query']}}}} });

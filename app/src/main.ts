import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { installApi } from './api';

createApp(App).mount('#app');
// window.voxpix: la app sin ratón, para agentes (api.ts; voxpix.help() la explica)
installApi();

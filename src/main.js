import { createApp } from 'vue'
import App from './App.vue'
import PrimeVue from 'primevue/config';

const app = createApp(App)

app.use(PrimeVue, { unstyled: true }); //has to add it to enable dt styling 
// router, pinia
app.mount('#app');

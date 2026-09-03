import { createApp } from 'vue'
import Buefy from 'buefy'
import 'buefy/dist/css/buefy.css'

import App from './App.vue'

const app = createApp(App)
// FontAwesome is loaded via CDN in index.html (pack "fas")
app.use(Buefy, { defaultIconPack: 'fas' })
app.mount('#app')

import { createApp } from 'vue'
// Register only the Buefy components the app renders (see `<b-*>` tags in
// src/). Add the matching plugin here when a new one is used.
import {
  Autocomplete, Button, Checkbox, Collapse, ConfigProgrammatic, Dropdown,
  Field, Icon, Input, Loading, Message, Modal, Pagination, Radio, Select,
  Slider, Switch, Table, Tabs, Tag, Tooltip,
} from 'buefy'
import 'buefy/dist/css/buefy.css'

import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(router)
// FontAwesome is loaded via CDN in index.html (pack "fas")
ConfigProgrammatic.setOptions({ defaultIconPack: 'fas' })
for (const plugin of [
  Autocomplete, Button, Checkbox, Collapse, Dropdown, Field, Icon, Input,
  Loading, Message, Modal, Pagination, Radio, Select, Slider, Switch, Table,
  Tabs, Tag, Tooltip,
]) app.use(plugin)
app.mount('#app')

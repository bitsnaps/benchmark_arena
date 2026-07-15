<script setup>
  import CButton from '@/CButton.vue'
  import { onMounted, ref  } from 'vue'

  const results = ref({});
  // const models_list = ref({});
  const models_details= ref({});

  onMounted(async () => {

    console.log('fetch results..');


    results.value = await fetch('benchmark_results.json')
      .then((r) => r.json())
      .then((data) => { 
        return {
          closed: data['unified_closed'],
          opened: data['unified_open']
        }
      });
    // // GET MODELS LIST 
    // models_list.value = await fetch ('benchmark_results.json')
    // .then(res => res.json())
    // .then(data => data.benchmarks);
    
    // GET MODELS LIST AND THEIR DETAILS
      models_details.value = await fetch('benchmark_results.json')
      .then(res => res.json())
      .then(data =>data.per_benchmark);
      console.log(models_details);  
    
  })

  const showAlert = () => {
    console.log("ok")
  }

</script>

<template>
  <div>

    <h1>You did it!</h1>

    <CButton variant="success" @callAction="showAlert">OK</CButton>

    <p>There are {{ results?.closed?.length }} closed and {{ results?.opened?.length }} opened. Choose your model bellow</p>
    <input type="text" list="models_datalist" placeholder="Choose a model">
  
    <datalist id="models_datalist">
      <!-- <option v-for="model in models_list" :key="model" :value="model"></option> -->
      <option v-for="(value, name) in models_details" :key="name" :value="name"></option>
    </datalist>
    <ul>
      <!-- <li v-for="model in models_details" :key="model" value="model">{{ model }}</li> -->
          <!-- <li v-for="(value, name) in models_details" :key="name" :value="name">{{ name }}: {{ value.closed.length }} closed / {{ value.open.length }} open</li> -->
          <li v-for="(value, name) in models_details" :key="name" :value="name">{{ name }}: {{ value.open}}</li>
    </ul>
    <!-- <ul>
      <li v-for="result in results.closed">{{ result.name }} ({{ result.avg }})
      </li>
    </ul>

    <ul>
      <li v-for="result in results.opened">{{ result.name }} ({{ result.avg }})</li>
    </ul> -->
    <br>
  </div>
</template>


<style scoped></style>

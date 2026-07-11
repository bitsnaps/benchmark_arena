<script setup>
import CButton from '@/CButton.vue'
import { onMounted, ref  } from 'vue'

const results = ref({});

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

    console.log(results.value);
    
  
})

const showAlert = () => {
  console.log("ok")
}

</script>

<template>
  <div>

    <h1>You did it!</h1>

    <CButton variant="success" @callAction="showAlert">OK</CButton>

    <p>There are {{ results?.closed?.length }} closed and {{ results?.opened?.length }} opened.</p>

    <ul>
      <li v-for="result in results.closed">{{ result.name }} ({{ result.avg }})
      </li>
    </ul>

    <ul>
      <li v-for="result in results.opened">{{ result.name }} ({{ result.avg }})</li>
    </ul>
    <br>
  </div>
</template>


<style scoped></style>

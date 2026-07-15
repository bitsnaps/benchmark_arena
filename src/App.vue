<script setup>
import { ref, onMounted, computed } from 'vue';
import DataTable from 'primevue/datatable';
import CButton from '@/CButton.vue';
import Column from 'primevue/column';
import StyleClass from 'primevue/styleclass'; //to check later 

const results = ref({});
const models_details = ref({});
const expandedRowGroups = ref(null); 


onMounted(async () => {
  console.log('fetching results..');
  const rawData = await fetch('benchmark_results.json').then((r) => r.json());
  console.log(rawData['benchmarks']);
  results.value = {
    closed: rawData['unified_closed'],
    opened: rawData['unified_open']
  };

  models_details.value = rawData.per_benchmark;
});

const tableData = computed(() => {
  let flatList = [];

  for (const [benchName, benchData] of Object.entries(models_details.value)) {
    if (benchData.closed) {
      for (const item of benchData.closed) {
        flatList.push({ benchmarkName: benchName, type: 'Closed', benName: item[0], score: item[1] });
      }
    }
    if (benchData.open) {
      for (const item of benchData.open) {
        flatList.push({ benchmarkName: benchName, type: 'Open', benName: item[0], score: item[1] });
      }
    }
  }
  return flatList;
});

const calculateGroupTotal = (benchmarkName) => {
  return tableData.value.filter(row => row.benchmarkName === benchmarkName).length;
};

const showAlert = () => {
  console.log("ok");
  // REMOVED THE TOAST CODE FROM HERE
};
const dt_style = ref({
  root: { 
    style: `
    padding: 20px;
      overflow: hidden; 
      background: rgba(36, 35, 55, 0.9);
      border-radius: 2rem; 
      color: #e2e8f0;
      font: Montserrat Medium;
    ` 
  },
  bodyrow: { 
    style: `
      background-color: rgba(59, 59, 93); 
    ` 
  },
  headerCell: {
    style: `
      background-color: rgb(36, 35, 55);
    `
  },
  
})
</script>

<template>
  <div>
    <div class="blank m-100"></div>
    <h1>Benchmarks Stats </h1>
    
    <!-- <p>There are {{ results?.closed?.length }} closed and {{ results?.opened?.length }} opened. Choose your model below</p> -->
    <label>Details about : </label> 
    <input type="text" list="models_datalist" placeholder="Choose a benchmark"> <!-- will be used for dt live filter -->
    <datalist id="models_datalist">
      <!-- <CButton variant="success" @callAction="showAlert">OK</CButton> -->

      <option v-for="(value, name) in models_details" :key="name" :value="name"></option>
    </datalist>

    <br><br>

    <!-- must install PRIMEVUE lib before using it -->
    <DataTable 
        v-model:expandedRowGroups="expandedRowGroups" 
        :value="tableData" 
        tableStyle="min-width: 50rem"
        expandableRowGroups 
        rowGroupMode="subheader" 
        groupRowsBy="benchmarkName" 
        sortMode="single" 
        sortField="benchmarkName" 
        :sortOrder="1"
        :pt="dt_style"
        >
      <template 
        #groupheader="slotProps">
            <span class="align-middle ml-2 font-bold leading-normal text-lg">
                {{ slotProps.data.benchmarkName }}
            </span>
        </template>

        <Column field="type" header="Benchmark" style="width: 15%"></Column>
        
        <Column field="benName" header="Model Name" style="width: 45%"></Column>
        
        <Column field="score" header="Score" style="width: 20%">
            <template #body="slotProps"> 
                <span v-if="slotProps.data.score !== null">{{ slotProps.data.score }}</span>
                <span v-else class="text-gray-400">N/A</span>
            </template>
        </Column>

        <template #groupfooter="slotProps">
            <div class="flex justify-end font-bold w-full pr-6"  style="background-color: rgba(59, 59, 93, 0.5);">
                Total : {{ calculateGroupTotal(slotProps.data.benchmarkName) }}
            </div>
        </template>
    </DataTable>
  </div>
</template>

<style scoped>
</style>
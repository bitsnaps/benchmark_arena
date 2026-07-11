<script setup>
import CButton from '@/CButton.vue'
import { onMounted, ref  } from 'vue'

const users = ref([]);

onMounted(async () => {

  console.log('fetch users..');

  users.value = await fetch('users.json')
    .then((r) => r.json())
    .then((data) => data)
  
})

const showAlert = () => {
  console.log("ok")
}

</script>

<template>
  <div>

    <h1>You did it!</h1>

    <CButton variant="success" @callAction="showAlert">OK</CButton>

    <p>There are {{ users?.length }} user(s).</p>
    <ul>
      <li v-for="user in users">{{ user.name }}</li>
    </ul>
  </div>
</template>


<style scoped></style>

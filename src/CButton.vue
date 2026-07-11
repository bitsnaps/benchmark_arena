<template>
    <button :class="`btn btn-${variant}`" @click="$emit('callAction')">
        <slot />
    </button>
</template>

<script setup>
defineProps({
    variant: String
})

</script>

<style scoped>
.btn-success {
    background-color: green;
}
</style>
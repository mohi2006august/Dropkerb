<template>
  <article data-spike-id="v01" class="card">
    <h3 data-spike-id="v02">{{ title }}</h3>
    <p data-spike-id="v03">{{ body }}</p>
    <span data-spike-id="v04" class="badge">new</span>
  </article>
</template>

<script setup>
defineProps({ title: String, body: String });
</script>

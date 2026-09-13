<template>
  <main data-spike-id="v05">
    <h1 data-spike-id="v06">Spike fixture</h1>
    <div data-spike-id="v07" class="toolbar">
      <button data-spike-id="v08" :aria-expanded="open" @click="open = !open">Filters</button>
      <div data-spike-id="v09" role="button" tabindex="0">Sort</div>
      <ul data-spike-id="v10" role="listbox" v-if="open">
        <li data-spike-id="v11" role="option">Recent</li>
      </ul>
    </div>
    <Card v-for="item in items" :key="item.id" :title="item.title" :body="item.body" />
    <form data-spike-id="v12" @submit.prevent>
      <p data-spike-id="v13" class="field">
        <label data-spike-id="v14" for="email">Email</label>
        <input data-spike-id="v15" id="email" type="text" />
      </p>
      <button data-spike-id="v16" type="submit">Create account</button>
    </form>
    <section data-spike-id="v17">
      <div data-spike-id="v18">
        <div data-spike-id="v19">
          <a data-spike-id="v20" href="/pricing">Learn more</a>
        </div>
      </div>
    </section>
  </main>
</template>

<script setup>
import { ref } from 'vue';
import Card from './Card.vue';

const open = ref(true);
const items = [
  { id: 'a', title: 'Quarterly report', body: 'Revenue is up.' },
  { id: 'b', title: 'Roadmap', body: 'Shipping in Q3.' },
];
</script>

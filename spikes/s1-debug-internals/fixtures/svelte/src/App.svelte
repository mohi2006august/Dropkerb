<script>
  import Card from './Card.svelte';

  let open = true;
  const items = [
    { id: 'a', title: 'Quarterly report', body: 'Revenue is up.' },
    { id: 'b', title: 'Roadmap', body: 'Shipping in Q3.' },
  ];
</script>

<main data-spike-id="s05">
  <h1 data-spike-id="s06">Spike fixture</h1>
  <div data-spike-id="s07" class="toolbar">
    <button data-spike-id="s08" aria-expanded={open} on:click={() => (open = !open)}>Filters</button>
    <div data-spike-id="s09" role="button" tabindex="0">Sort</div>
    {#if open}
      <ul data-spike-id="s10" role="listbox">
        <li data-spike-id="s11" role="option">Recent</li>
      </ul>
    {/if}
  </div>
  {#each items as item (item.id)}
    <Card title={item.title} body={item.body} />
  {/each}
  <form data-spike-id="s12">
    <p data-spike-id="s13" class="field">
      <label data-spike-id="s14" for="email">Email</label>
      <input data-spike-id="s15" id="email" type="text" />
    </p>
    <button data-spike-id="s16" type="submit">Create account</button>
  </form>
  <section data-spike-id="s17">
    <div data-spike-id="s18">
      <div data-spike-id="s19">
        <a data-spike-id="s20" href="/pricing">Learn more</a>
      </div>
    </div>
  </section>
</main>

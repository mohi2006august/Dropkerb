import styles from './page.module.css';
import Client from './Client.jsx';
import Nested from './Nested.jsx';

// A SERVER component - no 'use client'. Nothing here has a client-side fiber, which is
// exactly the condition TDD s5.8 says kills the primary attribution signal. Same
// one-tagged-element-per-line convention as the S1 fixtures, so ground truth is derived
// from this file rather than hand-maintained.
export default function Page() {
  const items = [
    { id: 'a', title: 'Quarterly report', body: 'Revenue is up.' },
    { id: 'b', title: 'Roadmap', body: 'Shipping in Q3.' },
  ];
  return (
    <main data-spike-id="r01">
      <h1 data-spike-id="r02">S2 RSC fixture</h1>
      <p data-spike-id="r03">Rendered on the server, with no client fiber.</p>
      <section data-spike-id="r04" className={styles.serverCard}>
        <h2 data-spike-id="r05" className={styles.serverHeading}>Server section</h2>
        <a data-spike-id="r06" href="/pricing">Learn more</a>
      </section>
      {items.map((it) => (
        <article data-spike-id="r07" key={it.id} className={styles.serverCard}>
          <h3 data-spike-id="r08">{it.title}</h3>
          <p data-spike-id="r09">{it.body}</p>
        </article>
      ))}
      <Nested />
      <Client />
    </main>
  );
}

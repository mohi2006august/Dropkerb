'use client';

import { useState } from 'react';
import styles from './page.module.css';

// A client component in the same App Router tree as the server page. It exists as the
// control: whatever attribution works here is the React 19 client path S1 already
// measured, so anything that fails ONLY on the server component is RSC-specific.
export default function Client() {
  const [open, setOpen] = useState(true);
  return (
    <div data-spike-id="c01" className={styles.clientToolbar}>
      <button data-spike-id="c02" aria-expanded={open} onClick={() => setOpen(!open)}>Filters</button>
      <div data-spike-id="c03" role="button" tabIndex={0}>Sort</div>
      {open ? (
        <ul data-spike-id="c04" role="listbox">
          <li data-spike-id="c05" role="option">Recent</li>
        </ul>
      ) : null}
    </div>
  );
}

// S1 fixture. Every element carrying data-spike-id keeps its opening tag on ONE line,
// because ground truth is derived by locating that line in this file (manifest.ts) and
// React's __source.lineNumber points at the line where the JSX element opens.
//
// The shape here is deliberate: tagged nodes appear at the app root, inside a plain
// child component, inside a component rendered through a .map(), inside a component
// that forwards refs, and inside one rendered from a variable - because those are the
// cases where the fiber walk has to climb a different number of levels to find a
// _debugSource, and a resolver that only works on the simple case is not a resolver.
import { useState } from 'react';

function Badge({ label }) {
  return <span data-spike-id="n01" className="badge">{label}</span>;
}

function Card({ title, body }) {
  return (
    <article data-spike-id="n02" className="card">
      <h3 data-spike-id="n03">{title}</h3>
      <p data-spike-id="n04">{body}</p>
      <Badge label="new" />
    </article>
  );
}

function Toolbar() {
  // Open by default: the point of the fixture is attribution, and a node behind an
  // interaction is a question for the Explorer (S3), not for the resolver.
  const [open, setOpen] = useState(true);
  return (
    <div data-spike-id="n05" className="toolbar">
      <button data-spike-id="n06" onClick={() => setOpen(!open)} aria-expanded={open}>Filters</button>
      <div data-spike-id="n07" role="button" tabIndex={0} onClick={() => {}}>Sort</div>
      {open ? (
        <ul data-spike-id="n08" role="listbox">
          <li data-spike-id="n09" role="option">Recent</li>
        </ul>
      ) : null}
    </div>
  );
}

function Field({ id, label }) {
  return (
    <p data-spike-id="n10" className="field">
      <label data-spike-id="n11" htmlFor={id}>{label}</label>
      <input data-spike-id="n12" id={id} type="text" />
    </p>
  );
}

function SignupForm() {
  return (
    <form data-spike-id="n13" onSubmit={(e) => e.preventDefault()}>
      <Field id="email" label="Email" />
      <Field id="name" label="Full name" />
      <button data-spike-id="n14" type="submit">Create account</button>
    </form>
  );
}

const Deep = () => (
  <section data-spike-id="n15">
    <div data-spike-id="n16">
      <div data-spike-id="n17">
        <a data-spike-id="n18" href="/pricing">Learn more</a>
      </div>
    </div>
  </section>
);

export default function App() {
  const items = [
    { id: 'a', title: 'Quarterly report', body: 'Revenue is up.' },
    { id: 'b', title: 'Roadmap', body: 'Shipping in Q3.' },
  ];
  return (
    <main data-spike-id="n19">
      <h1 data-spike-id="n20">Spike fixture</h1>
      <Toolbar />
      {items.map((it) => (
        <Card key={it.id} title={it.title} body={it.body} />
      ))}
      <SignupForm />
      <Deep />
    </main>
  );
}

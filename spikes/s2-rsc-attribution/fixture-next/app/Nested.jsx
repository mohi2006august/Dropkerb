// A second server component, in its own file, so the spike can tell "attributed to the
// right FILE" apart from "attributed to the page that happened to render it".
export default function Nested() {
  return (
    <section data-spike-id="r10">
      <div data-spike-id="r11">
        <img data-spike-id="r12" src="/next.svg" alt="" width="32" height="32" />
        <button data-spike-id="r13" type="button">Server-rendered button</button>
      </div>
    </section>
  );
}

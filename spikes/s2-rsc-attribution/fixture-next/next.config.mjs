/** @type {import('next').NextConfig} */
const nextConfig = {
  // Source maps in the browser bundle are what TDD s5.2 depends on; the S2 question
  // is partly whether they survive the App Router build, so ask for them explicitly.
  productionBrowserSourceMaps: true,
};
export default nextConfig;

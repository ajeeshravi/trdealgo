/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Next 14 modularises the listed packages so only the imports we actually
  // use end up in the dev/prod bundle. Without this every `import { Foo }
  // from "lucide-react"` pulls the entire icon set into the compile graph,
  // which is the bulk of the "2208 modules" compile time on the dashboard.
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "@radix-ui/react-avatar",
      "@radix-ui/react-collapsible",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-label",
      "@radix-ui/react-popover",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
    ],
  },
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/ws/:path*", destination: `${api}/api/v1/ws/:path*` },
    ];
  },
};
export default nextConfig;

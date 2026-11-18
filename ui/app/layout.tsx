import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "qwen7b serving",
  description: "Qwen2.5-7B served by TensorRT-LLM and vLLM, with measured latency, throughput and accuracy.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="flex h-dvh flex-col font-sans antialiased">
        <Nav />
        <main className="min-h-0 flex-1">{children}</main>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";

export const metadata: Metadata = {
  title: "Ouroboros · AI analytics and marketing desk",
  description:
    "An analytics and marketing desk staffed by AI agents: one brief becomes data models, a dashboard, a report and a campaign, refreshed on schedule.",
};

export default function LandingPage() {
  return <Landing />;
}

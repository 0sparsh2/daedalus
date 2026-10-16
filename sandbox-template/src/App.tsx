import { Sparkles } from "lucide-react";
import { EmptyState, Page } from "./components/ui";

export default function App() {
  return (
    <Page width="sm" className="min-h-screen justify-center">
      <EmptyState icon={Sparkles} title="Your app will appear here" description="Describe what you want to build in the chat." />
    </Page>
  );
}

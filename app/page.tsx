import { VoiceStudio } from "@/components/VoiceStudio";

export const dynamic = "force-dynamic";

export default function Home() {
  return <VoiceStudio voiceConfigured={Boolean(process.env.OPENAI_API_KEY?.trim())} />;
}

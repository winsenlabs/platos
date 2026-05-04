import { Body, Head, Html, Link, Preview, Section, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { anchor, bullets, footerItalic, main, paragraphLight } from "./components/styles";

export default function Email({ name }: { name?: string }) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Platos</Preview>
      <Body style={main}>
        <Text style={paragraphLight}>Hey {name ?? "there"},</Text>
        <Text style={paragraphLight}>Welcome to Platos — the open-source agent runtime.</Text>
        <Text style={paragraphLight}>
          Platos lets you build durable AI agents on the same runtime that runs your background
          jobs: streaming, tool-calling, prompt caching, HITL approvals, conversation compaction,
          and a multi-tenant tool matrix — all Apache 2.0 and self-hostable.
        </Text>
        <Text style={paragraphLight}>
          {/* TODO(Theme-P): point at docs.platos.dev/quickstart once the docs site ships */}
          The{" "}
          <Link style={anchor} href="https://github.com/platos-dev/platos#quickstart">
            quickstart guide
          </Link>{" "}
          walks you from zero to your first agent reply in about twenty minutes.
        </Text>

        <Text style={paragraphLight}>
          {/* TODO(Theme-BR-community): swap for a Platos community channel once it exists */}
          Questions or ideas? Join the conversation on{" "}
          <Link style={anchor} href="https://github.com/platos-dev/platos/discussions">
            GitHub Discussions
          </Link>
          .
        </Text>

        <Text style={paragraphLight}>We hope you enjoy using Platos!</Text>

        <Text style={bullets}>Best,</Text>
        <Text style={bullets}>The Platos team</Text>
        <Text style={footerItalic}>
          If you don’t want to receive these emails, please let us know and we’ll update your
          preferences.
        </Text>
        <Footer />
      </Body>
    </Html>
  );
}

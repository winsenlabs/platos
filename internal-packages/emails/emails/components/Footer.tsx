import { Hr, Link, Text } from "@react-email/components";
import React from "react";
import { footer, footerAnchor, hr } from "./styles";

// TODO(Theme-BR-community): self-hosters should override this footer with
// their own legal-entity address. The Platos OSS build ships a neutral
// project-level footer pointing at the GitHub repo.
export function Footer() {
  return (
    <>
      <Hr style={hr} />
      <Text style={footer}>
        Platos — the open-source agent runtime.{" "}
        <Link style={footerAnchor} href="https://github.com/platos-dev/platos">
          github.com/platos-dev/platos
        </Link>
      </Text>
    </>
  );
}

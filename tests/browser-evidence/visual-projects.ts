import { devices } from "@playwright/test";

export function browserVisualProjects() {
  const mobileDevice = devices["Pixel 5"];
  if (!mobileDevice) throw new Error("Playwright lacks the required Pixel 5 mobile descriptor");

  return [
    {
      name: "desktop-light",
      use: { ...devices["Desktop Chrome"], colorScheme: "light" as const },
    },
    {
      name: "desktop-dark",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" as const },
    },
    {
      name: "mobile-light",
      use: { ...mobileDevice, colorScheme: "light" as const },
    },
    {
      name: "mobile-dark",
      use: { ...mobileDevice, colorScheme: "dark" as const },
    },
  ];
}

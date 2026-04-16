import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock next/navigation for component tests
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/prs"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  redirect: vi.fn(),
}));

// Mock next-auth/react for component tests that render authenticated UI
vi.mock("next-auth/react", () => ({
  useSession: vi.fn(() => ({
    data: {
      user: {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        teamIds: ["team-1"],
      },
      accessToken: "tok-test",
    },
    status: "authenticated",
  })),
  signIn: vi.fn(),
  signOut: vi.fn(),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Stub global fetch for unit tests — integration tests override per-test
global.fetch = vi.fn();

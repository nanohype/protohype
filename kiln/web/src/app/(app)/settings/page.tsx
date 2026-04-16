import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReposTab } from "./repos-tab";
import { GroupingTab } from "./grouping-tab";
import { NotificationsTab } from "./notifications-tab";
import { SkipListTab } from "./skip-list-tab";

export const metadata = { title: "Settings — Kiln" };

/**
 * Team settings — four tabs:
 * Repos | Grouping | Notifications | Skip list
 */
export default function SettingsPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Configure Kiln for your team. Changes take effect on the next polling
          cycle.
        </p>
      </div>

      <Tabs defaultValue="repos">
        <TabsList>
          <TabsTrigger value="repos">Repositories</TabsTrigger>
          <TabsTrigger value="grouping">Grouping</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="skiplist">Skip list</TabsTrigger>
        </TabsList>

        <TabsContent value="repos" className="mt-4">
          <ReposTab />
        </TabsContent>
        <TabsContent value="grouping" className="mt-4">
          <GroupingTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab />
        </TabsContent>
        <TabsContent value="skiplist" className="mt-4">
          <SkipListTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

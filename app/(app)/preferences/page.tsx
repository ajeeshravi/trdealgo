"use client";
import { PreferencesPanel } from "@/components/settings/PreferencesPanel";
import { NotificationPreferencesPanel } from "@/components/settings/NotificationPreferencesPanel";

export default function PreferencesPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Preferences</h1>
        <p className="text-sm text-muted-foreground">
          Personal display + notification settings.
        </p>
      </header>
      <PreferencesPanel />
      <section id="notifications">
        <h2 className="text-lg font-semibold mb-3">Notifications</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Configure how each kind of platform event reaches you — in-app, email, Telegram,
          Discord, or a webhook. The centralised Notification Bus routes every event
          (order placed, RMS block, strategy stop, broker login failure, system errors) through
          these rules.
        </p>
        <NotificationPreferencesPanel />
      </section>
    </div>
  );
}

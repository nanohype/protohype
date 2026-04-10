"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Header from "@/components/Header";
import SummaryBar from "@/components/SummaryBar";
import BudgetBanner from "@/components/BudgetBanner";
import AgentCostChart from "@/components/AgentCostChart";
import WorkflowDonut from "@/components/WorkflowDonut";
import TokenTimeline from "@/components/TokenTimeline";
import SessionTable from "@/components/SessionTable";
import EmptyState from "@/components/EmptyState";
import type { DashboardSummary, AgentCost, WorkflowCost, DayBucket, EnrichedSession } from "@/src/schema";

const REFRESH_INTERVAL = 30_000; // 30 seconds

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [agentCosts, setAgentCosts] = useState<AgentCost[]>([]);
  const [workflowCosts, setWorkflowCosts] = useState<WorkflowCost[]>([]);
  const [dayBuckets, setDayBuckets] = useState<DayBucket[]>([]);
  const [sessions, setSessions] = useState<EnrichedSession[]>([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSearch, setSessionSearch] = useState("");
  const [timeFilter, setTimeFilter] = useState<"session" | "today" | "week" | "all">("today");
  const [timelineDays, setTimelineDays] = useState(7);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);

  const fetchAll = useCallback(async (filter = timeFilter, days = timelineDays, page = sessionPage, search = sessionSearch) => {
    setRefreshing(true);
    setError(null);
    try {
      const [summaryRes, trendsRes, sessionsRes] = await Promise.all([
        fetch("/api/summary"),
        fetch(`/api/trends?filter=${filter}&days=${days}`),
        fetch(`/api/sessions?page=${page}&perPage=50&q=${encodeURIComponent(search)}`),
      ]);

      if (!summaryRes.ok || !trendsRes.ok || !sessionsRes.ok) {
        throw new Error("API error");
      }

      const [s, t, sess] = await Promise.all([
        summaryRes.json(),
        trendsRes.json(),
        sessionsRes.json(),
      ]);

      setSummary(s);
      setAgentCosts(t.agentCosts);
      setWorkflowCosts(t.workflowCosts);
      setDayBuckets(t.dayBuckets);
      setSessions(sess.items);
      setSessionTotal(sess.total);
      setIsEmpty(sess.total === 0);
      setLastRefreshed(new Date());
    } catch (err) {
      setError("Refresh failed — check server");
    } finally {
      setRefreshing(false);
    }
  }, [timeFilter, timelineDays, sessionPage, sessionSearch]);

  // Initial load
  useEffect(() => { fetchAll(); }, []);

  // Auto-refresh
  useEffect(() => {
    const id = setInterval(() => fetchAll(), REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAll]);

  // Re-fetch when filters change
  useEffect(() => { fetchAll(timeFilter, timelineDays, 1, sessionSearch); }, [timeFilter, timelineDays]);
  useEffect(() => { fetchAll(timeFilter, timelineDays, sessionPage, sessionSearch); }, [sessionPage]);

  const handleSearch = useCallback((q: string) => {
    setSessionSearch(q);
    setSessionPage(1);
    fetchAll(timeFilter, timelineDays, 1, q);
  }, [timeFilter, timelineDays, fetchAll]);

  const handleSeedSample = async () => {
    await fetch("/api/seed", { method: "POST" });
    fetchAll();
  };

  if (isEmpty && !refreshing && sessions.length === 0) {
    return (
      <>
        <Header lastRefreshed={lastRefreshed} refreshing={refreshing} error={error} />
        <EmptyState onSeedSample={handleSeedSample} />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 font-mono">
      <Header lastRefreshed={lastRefreshed} refreshing={refreshing} error={error} />

      <main className="max-w-[1600px] mx-auto px-4 py-4 space-y-4">
        {/* Budget alert banner */}
        {summary && <BudgetBanner summary={summary} />}

        {/* Summary cards */}
        {summary && <SummaryBar summary={summary} />}

        {/* Two-column: agent cost + workflow donut */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <AgentCostChart
            data={agentCosts}
            filter={timeFilter}
            onFilterChange={setTimeFilter}
          />
          <WorkflowDonut
            data={workflowCosts}
            filter={timeFilter}
            onFilterChange={setTimeFilter}
          />
        </div>

        {/* Token timeline */}
        <TokenTimeline
          data={dayBuckets}
          days={timelineDays}
          onDaysChange={setTimelineDays}
        />

        {/* Session table */}
        <SessionTable
          sessions={sessions}
          total={sessionTotal}
          page={sessionPage}
          onPageChange={setSessionPage}
          search={sessionSearch}
          onSearchChange={handleSearch}
        />
      </main>
    </div>
  );
}

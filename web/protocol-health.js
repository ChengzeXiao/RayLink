window.RayLinkProtocolHealth = (() => {
  function checkedTime(value) {
    if (!value) return "尚未检测";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function finiteMilliseconds(value) {
    return value !== null && value !== undefined && value !== ""
      && typeof value !== "boolean" && Number.isFinite(Number(value)) && Number(value) >= 0
      ? `${Math.max(0, Math.round(Number(value)))} ms`
      : "—";
  }

  function availabilityRate(samples) {
    const count = Number(samples?.count);
    const successful = Number(samples?.successful);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(successful)) return "—";
    return `${Math.round(Math.max(0, Math.min(count, successful)) / count * 100)}%`;
  }

  function percentage(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return "—";
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    return `${Math.max(0, Math.min(100, Math.round(numeric * 10) / 10))}%`;
  }

  function layerSummary(layers) {
    if (!layers) return "";
    const status = {
      passed: "通过",
      failed: "失败",
      "last-known": "上次已监听",
      "not-measured": "未检测",
      unknown: "待确认"
    };
    return [
      `端口 ${status[layers.port] || status.unknown}`,
      `协议握手 ${status[layers.handshake] || status.unknown}`,
      `公网访问 ${status[layers.public] || status.unknown}`
    ].join(" · ");
  }

  function present(activation) {
    const check = activation?.publicCheck;
    if (!check?.checkedAt) {
      return {
        label: "待检测",
        availabilityLabel: "待检测",
        latencyLabel: "—",
        p95Label: "—",
        jitterLabel: "—",
        availabilityRateLabel: "—",
        rollingAvailabilityLabel: "—",
        layersLabel: "",
        checkedLabel: "尚未检测",
        className: "neutral",
        summary: "尚未执行协议连接测试",
        title: "尚未执行协议连接测试"
      };
    }
    const checkedLabel = checkedTime(check.checkedAt);
    if (check.unsupported) {
      const reason = check.reason || "该协议不提供独立连接检测";
      return {
        label: "不适用",
        availabilityLabel: "不适用",
        latencyLabel: "—",
        p95Label: "—",
        jitterLabel: "—",
        availabilityRateLabel: "—",
        rollingAvailabilityLabel: "—",
        layersLabel: "",
        checkedLabel,
        className: "neutral",
        summary: `${reason} · 最近检测 ${checkedLabel}`,
        title: `${reason} · 最近检测 ${checkedLabel}`
      };
    }

    const probeLabel = check.probe === "sing-box-tools-fetch"
      ? "完整协议握手与外部访问"
      : check.probe === "tcp-connect"
        ? "TCP 连接"
        : "协议连接";
    const latencyLabel = finiteMilliseconds(check.latencyMs);
    const p95Label = finiteMilliseconds(check.p95Ms);
    const jitterLabel = finiteMilliseconds(check.jitterMs);
    const availabilityRateLabel = availabilityRate(check.samples);
    const rollingAvailabilityLabel = percentage(check.healthWindow?.successRate);
    const layersLabel = layerSummary(check.layers);
    // Keep the evidence window aligned with SMART_PROTOCOL_HEALTH_MAX_AGE_MS.
    const ageMs = Date.now() - new Date(check.checkedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < -60_000 || ageMs > 15 * 60_000) {
      const summary = `检测结果已过期或时间异常，请重新检测 · 上次记录 ${checkedLabel}`;
      return {
        label: "待复检", availabilityLabel: "待复检", className: "warning",
        latencyLabel, p95Label, jitterLabel, availabilityRateLabel,
        rollingAvailabilityLabel, layersLabel, checkedLabel, summary, title: summary
      };
    }
    const rateSummary = availabilityRateLabel === "—"
      ? ""
      : ` · 本轮成功率 ${availabilityRateLabel}`;
    const rollingSummary = rollingAvailabilityLabel === "—"
      ? ""
      : ` · 窗口成功率 ${rollingAvailabilityLabel}`;
    const p95Summary = p95Label === "—" ? "" : ` · P95 ${p95Label}`;
    const layerText = layersLabel ? ` · ${layersLabel}` : "";
    const legacyUnconfirmedFailure = check.reachable === false
      && check.availability === undefined
      && check.consecutiveFailures === undefined;
    const failures = legacyUnconfirmedFailure
      ? 1
      : Math.min(3, Math.max(0, Number(check.consecutiveFailures || 0)));

    if ((check.availability === "degraded" || legacyUnconfirmedFailure) && failures > 0) {
      const summary = `复检中 ${failures}/3 · 最近成功 ${latencyLabel}${p95Summary} · 抖动 ${jitterLabel}${rateSummary}${rollingSummary}${layerText} · 最近检测 ${checkedLabel}`;
      return {
        label: `复检 ${failures}/3`,
        availabilityLabel: "复检中",
        latencyLabel,
        p95Label,
        jitterLabel,
        availabilityRateLabel,
        rollingAvailabilityLabel,
        layersLabel,
        checkedLabel,
        className: "warning",
        summary,
        title: `${summary} · ${check.error || "本轮连接失败"}`
      };
    }

    if (check.availability === "degraded") {
      const summary = `质量降级 · 连接耗时 ${latencyLabel}${p95Summary} · 抖动 ${jitterLabel}${rateSummary}${rollingSummary}${layerText} · 最近检测 ${checkedLabel}`;
      return {
        label: "质量降级",
        availabilityLabel: "质量降级",
        latencyLabel,
        p95Label,
        jitterLabel,
        availabilityRateLabel,
        rollingAvailabilityLabel,
        layersLabel,
        checkedLabel,
        className: "warning",
        summary,
        title: `${probeLabel} · ${summary}`
      };
    }

    if (check.reachable === true && check.availability !== "unavailable") {
      const latencyMs = Math.max(0, Math.round(Number(check.latencyMs)));
      const summary = `可用 · 连接耗时 ${latencyLabel}${p95Summary} · 抖动 ${jitterLabel}${rateSummary}${rollingSummary}${layerText} · 最近检测 ${checkedLabel}`;
      return {
        label: latencyLabel === "—" ? "可用 · 未计时" : latencyLabel,
        availabilityLabel: "可用",
        latencyLabel,
        p95Label,
        jitterLabel,
        availabilityRateLabel,
        rollingAvailabilityLabel,
        layersLabel,
        checkedLabel,
        className: latencyLabel !== "—" && latencyMs <= 120 ? "good" : "warning",
        summary,
        title: `${probeLabel} · ${summary}`
      };
    }

    const timedOut = /tim(?:e|ed)[ -]?out|超时/i.test(String(check.error || ""));
    const label = timedOut ? "超时" : "不可达";
    const lastSuccess = latencyLabel === "—" ? "" : ` · 最近成功 ${latencyLabel}`;
    const lastJitter = jitterLabel === "—" ? "" : ` · 抖动 ${jitterLabel}`;
    const summary = `${label}${lastSuccess}${p95Summary}${lastJitter}${rateSummary}${rollingSummary}${layerText} · 连续失败 ${failures}/3 · 最近检测 ${checkedLabel}`;
    return {
      label,
      availabilityLabel: "不可用",
      latencyLabel,
      p95Label,
      jitterLabel,
      availabilityRateLabel,
      rollingAvailabilityLabel,
      layersLabel,
      checkedLabel,
      className: "danger",
      summary,
      title: `${summary} · ${check.error || "协议连接测试失败"}`
    };
  }

  return Object.freeze({ present });
})();

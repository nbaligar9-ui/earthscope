"use strict";

(() => {
  const MIN_YEAR = 2015;
  const MAX_YEAR = 2025;
  const ALPHA = 0.05;
  const LOCATIONS = {
    belagavi: { name: "Belagavi, Karnataka", country: "India", latitude: 15.8497, longitude: 74.4977 },
    bengaluru: { name: "Bengaluru, Karnataka", country: "India", latitude: 12.9716, longitude: 77.5946 },
    mumbai: { name: "Mumbai, Maharashtra", country: "India", latitude: 19.0760, longitude: 72.8777 },
    delhi: { name: "Delhi, NCT", country: "India", latitude: 28.6139, longitude: 77.2090 },
    chennai: { name: "Chennai, Tamil Nadu", country: "India", latitude: 13.0827, longitude: 80.2707 },
    london: { name: "London", country: "United Kingdom", latitude: 51.5072, longitude: -0.1276 },
  };

  const elements = {
    form: document.getElementById("investigation-form"),
    locationSelect: document.getElementById("location-select"),
    startYear: document.getElementById("start-year"),
    endYear: document.getElementById("end-year"),
    submitButton: document.querySelector("#investigation-form button[type='submit']"),
    status: document.getElementById("data-status"),
    statusText: document.getElementById("status-text"),
    errorPanel: document.getElementById("error-panel"),
    errorMessage: document.getElementById("error-message"),
    retryButton: document.getElementById("retry-button"),
    canvas: document.getElementById("temperature-chart"),
    chartStage: document.getElementById("chart-stage"),
    tooltip: document.getElementById("chart-tooltip"),
    chartEmpty: document.getElementById("chart-empty"),
    chartTitle: document.getElementById("chart-title"),
    chartNote: document.getElementById("chart-note"),
    trendLegend: document.getElementById("trend-legend"),
    legendLabel: document.getElementById("legend-label"),
    tableBody: document.getElementById("year-table-body"),
  };
  const context = elements.canvas.getContext("2d");
  let daily = [];
  let yearly = [];
  let trend = null;
  let missingCount = 0;
  let view = "annual";
  let resizeObserver;
  let requestController = null;

  function getSelection() {
    const location = LOCATIONS[elements.locationSelect.value];
    const startYear = Number(elements.startYear.value);
    const endYear = Number(elements.endYear.value);
    if (!location || !Number.isInteger(startYear) || !Number.isInteger(endYear)
      || startYear < MIN_YEAR || endYear > MAX_YEAR || startYear > endYear) {
      throw new Error("Choose a supported location and a year range from 2015 to 2025.");
    }
    return { location, startYear, endYear };
  }

  function makeApiUrl(location, startYear, endYear) {
    const parameters = new URLSearchParams({
      parameters: "T2M",
      community: "RE",
      longitude: String(location.longitude),
      latitude: String(location.latitude),
      start: `${startYear}0101`,
      end: `${endYear}1231`,
      format: "JSON",
    });
    return `https://power.larc.nasa.gov/api/temporal/daily/point?${parameters.toString()}`;
  }

  function updateLocationLabels(location, startYear, endYear) {
    const heroLocation = document.getElementById("hero-location");
    const heroCoordinates = document.getElementById("hero-coordinates");
    const latitudeHemisphere = location.latitude < 0 ? "S" : "N";
    const longitudeHemisphere = location.longitude < 0 ? "W" : "E";
    heroLocation.textContent = `${location.name}, ${location.country}`;
    heroCoordinates.textContent = `${Math.abs(location.latitude).toFixed(2)}° ${latitudeHemisphere} / ${Math.abs(location.longitude).toFixed(2)}° ${longitudeHemisphere}`;
    document.getElementById("graphic-latitude").textContent = `${Math.abs(location.latitude).toFixed(2)}° ${latitudeHemisphere}`;
    document.getElementById("hero-period").textContent = `${startYear} — ${endYear}`;
    document.getElementById("method-location").textContent = location.name;
    document.getElementById("method-start").textContent = `${startYear}-01-01`;
    document.getElementById("method-end").textContent = `${endYear}-12-31`;
    document.getElementById("source-coordinates").textContent =
      `POINT: ${Math.abs(location.latitude).toFixed(4)}° ${latitudeHemisphere}, ${Math.abs(location.longitude).toFixed(4)}° ${longitudeHemisphere}`;
    elements.chartTitle.textContent = `${view === "annual" ? "Annual mean" : "Daily"} temperature · ${location.name.split(",")[0]}`;
    document.getElementById("table-title").textContent = `Annual temperature · ${location.name.split(",")[0]}`;
  }

  function setStatus(message, state) {
    elements.statusText.textContent = message;
    elements.status.classList.toggle("is-error", state === "error");
    elements.status.classList.toggle("is-loading", state === "loading");
  }

  function setLoading(isLoading, selection) {
    elements.retryButton.disabled = isLoading;
    elements.retryButton.textContent = isLoading ? "Loading…" : "Try again ↻";
    elements.errorPanel.hidden = true;
    elements.chartEmpty.hidden = false;
    elements.chartEmpty.textContent = isLoading
      ? `Requesting live NASA POWER data for ${selection.location.name}…`
      : "Waiting for NASA POWER observations…";
    elements.canvas.setAttribute("aria-label", `Loading NASA POWER temperature data for ${selection.location.name}, ${selection.startYear} to ${selection.endYear}.`);
    setStatus(isLoading
      ? `Loading ${selection.location.name} · ${selection.startYear}–${selection.endYear}…`
      : "Connecting to NASA POWER…", isLoading ? "loading" : "");
  }

  function formatNumber(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "—";
  }

  function expectedDays(year) {
    return new Date(Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)).getTime() / 86400000;
  }

  function parseDailyResponse(payload, startYear, endYear) {
    const header = payload && payload.header;
    if (!header || header.start !== `${startYear}0101` || header.end !== `${endYear}1231`) {
      throw new Error("The NASA POWER response metadata did not match the requested date range.");
    }
    const fillValue = Number(header.fill_value);
    if (!Number.isFinite(fillValue)) {
      throw new Error("The NASA POWER response did not specify its missing-data fill value.");
    }
    const values = payload && payload.properties && payload.properties.parameter && payload.properties.parameter.T2M;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("The NASA POWER response did not contain the expected T2M daily data.");
    }

    const parsed = [];
    let missingValues = 0;
    const seenDates = new Set();
    for (const [date, rawValue] of Object.entries(values)) {
      if (!/^\d{8}$/.test(date)) {
        throw new Error("The NASA POWER T2M response contained an invalid date key.");
      }
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(4, 6));
      const day = Number(date.slice(6, 8));
      const timestamp = Date.UTC(year, month - 1, day);
      const parsedDate = new Date(timestamp);
      if (year < startYear || year > endYear
        || parsedDate.getUTCFullYear() !== year
        || parsedDate.getUTCMonth() !== month - 1
        || parsedDate.getUTCDate() !== day) {
        throw new Error(`The NASA POWER T2M response contained an out-of-range or invalid date: ${date}.`);
      }
      if (seenDates.has(date)) {
        throw new Error(`The NASA POWER T2M response contained a duplicate date: ${date}.`);
      }
      seenDates.add(date);
      if (typeof rawValue !== "number" && (typeof rawValue !== "string" || rawValue.trim() === "")) {
        throw new Error(`The NASA POWER T2M response contained an invalid value for ${date}.`);
      }
      const value = Number(rawValue);
      if (!Number.isFinite(value)) {
        throw new Error(`The NASA POWER T2M response contained a non-numeric value for ${date}.`);
      }
      if (value === fillValue) {
        missingValues++;
        continue;
      }
      parsed.push({
        date,
        year,
        value,
        timestamp,
      });
    }
    parsed.sort((a, b) => a.timestamp - b.timestamp);
    if (parsed.length === 0) {
      throw new Error("NASA POWER returned no valid T2M values for the requested period.");
    }
    return { records: parsed, missingCount: missingValues };
  }

  function summarize(dailyValues, startYear, endYear) {
    const sums = new Map();
    for (let year = startYear; year <= endYear; year++) sums.set(year, { sum: 0, count: 0 });
    let total = 0;
    for (const record of dailyValues) {
      const bucket = sums.get(record.year);
      if (!bucket) continue;
      bucket.sum += record.value;
      bucket.count += 1;
      total += record.value;
    }
    const annual = [];
    for (const [year, bucket] of sums) {
      annual.push({
        year,
        mean: bucket.count ? bucket.sum / bucket.count : null,
        count: bucket.count,
        coverage: bucket.count / expectedDays(year),
      });
    }
    return { annual, overallMean: total / dailyValues.length };
  }

  function linearRegression(points) {
    const meanX = points.reduce((sum, point) => sum + point.year, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.mean, 0) / points.length;
    let covariance = 0;
    let varianceX = 0;
    for (const point of points) {
      covariance += (point.year - meanX) * (point.mean - meanY);
      varianceX += (point.year - meanX) ** 2;
    }
    const slope = covariance / varianceX;
    return { slope, intercept: meanY - slope * meanX, meanY };
  }

  function mannKendall(values) {
    let score = 0;
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    for (let i = 0; i < values.length - 1; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (values[j] > values[i]) score++;
        else if (values[j] < values[i]) score--;
      }
    }
    const n = values.length;
    let tieCorrection = 0;
    for (const count of counts.values()) {
      if (count > 1) tieCorrection += count * (count - 1) * (2 * count + 5);
    }
    const variance = (n * (n - 1) * (2 * n + 5) - tieCorrection) / 18;
    if (variance <= 0) return { score, z: 0, p: 1, tau: 0 };
    const z = score > 0 ? (score - 1) / Math.sqrt(variance)
      : score < 0 ? (score + 1) / Math.sqrt(variance)
        : 0;
    const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
    return { score, z, p, tau: score / (n * (n - 1) / 2) };
  }

  function normalCdf(z) {
    const x = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return 0.5 * (1 + Math.sign(z) * erf);
  }

  function updateMetrics(annual, overallMean) {
    const selection = getSelection();
    const availableYears = annual.filter((point) => Number.isFinite(point.mean));
    const count = daily.length;
    let expected = 0;
    for (let year = selection.startYear; year <= selection.endYear; year++) expected += expectedDays(year);
    const coverage = count / expected * 100;
    document.getElementById("period-mean").innerHTML = `${formatNumber(overallMean)}<small>°C</small>`;
    const missingNote = missingCount ? ` · ${missingCount.toLocaleString()} NASA missing-value markers excluded` : "";
    document.getElementById("period-mean-foot").textContent = `Mean of ${count.toLocaleString()} valid daily values${missingNote}`;
    document.getElementById("valid-count").textContent = count.toLocaleString();
    document.getElementById("coverage-foot").textContent = `${formatNumber(coverage, 1)}% of ${expected.toLocaleString()} calendar days`;

    if (availableYears.length >= 2) {
      trend = linearRegression(availableYears);
      const perDecade = trend.slope * 10;
      document.getElementById("trend-value").innerHTML = `${perDecade >= 0 ? "+" : ""}${formatNumber(perDecade)}<small>°C / decade</small>`;
      document.getElementById("trend-foot").textContent = `OLS slope · ${availableYears.length} annual means`;
      document.getElementById("finding-slope").textContent = `${trend.slope >= 0 ? "+" : ""}${formatNumber(trend.slope, 4)} °C/year`;
      document.getElementById("finding-trend-title").textContent = perDecade > 0 ? "Warming direction" : perDecade < 0 ? "Cooling direction" : "No linear change";
      document.getElementById("finding-trend-copy").textContent = `The fitted line changes by ${formatNumber(Math.abs(perDecade))} °C per decade${perDecade >= 0 ? " upward" : " downward"}. This is a descriptive estimate from annual means, not a forecast.`;
    } else {
      trend = null;
      document.getElementById("trend-value").innerHTML = `—<small>°C / decade</small>`;
      document.getElementById("trend-foot").textContent = "At least two annual means are needed";
      document.getElementById("finding-trend-title").textContent = "Trend unavailable";
      document.getElementById("finding-trend-copy").textContent = "At least two years with valid daily readings are needed to calculate a linear temperature trend.";
      document.getElementById("finding-slope").textContent = "—";
    }
    elements.trendLegend.hidden = view !== "annual" || !trend;

    if (availableYears.length >= 3) {
      const mkResult = mannKendall(availableYears.map((point) => point.mean));
      const significant = mkResult.p < ALPHA;
      const direction = mkResult.score > 0 ? "increasing" : mkResult.score < 0 ? "decreasing" : "no directional";
      document.getElementById("mk-result").textContent = significant ? `Significant ${direction}` : "Not significant";
      document.getElementById("mk-foot").textContent = `p = ${formatP(mkResult.p)} · τ = ${formatNumber(mkResult.tau, 2)}`;
      document.getElementById("finding-mk-title").textContent = significant ? `Significant ${direction} trend` : "No significant trend detected";
      document.getElementById("finding-mk-copy").textContent = `Mann–Kendall S = ${mkResult.score}; Z = ${formatNumber(mkResult.z, 2)}. ${significant ? `The monotonic trend is statistically significant at α = ${ALPHA}.` : `The evidence is insufficient to reject no monotonic trend at α = ${ALPHA}.`}`;
      document.getElementById("finding-p").textContent = formatP(mkResult.p);
    } else {
      document.getElementById("mk-result").textContent = "Insufficient years";
      document.getElementById("mk-foot").textContent = "At least three annual means are needed";
      document.getElementById("finding-mk-title").textContent = "Mann–Kendall test unavailable";
      document.getElementById("finding-mk-copy").textContent = "Select a period with at least three years of valid annual readings to calculate the monotonic trend test.";
      document.getElementById("finding-p").textContent = "—";
    }
    renderTable(annual, overallMean);
    if (availableYears.length) updateRangeFinding(availableYears);
  }

  function formatP(value) {
    return value < 0.001 ? "< 0.001" : formatNumber(value, 3);
  }

  function updateRangeFinding(annual) {
    const warmest = annual.reduce((a, b) => b.mean > a.mean ? b : a);
    const coolest = annual.reduce((a, b) => b.mean < a.mean ? b : a);
    document.getElementById("finding-range-title").textContent = "Warmest & coolest years";
    document.getElementById("finding-range-copy").textContent = `Warmest: ${warmest.year} at ${formatNumber(warmest.mean)} °C. Coolest: ${coolest.year} at ${formatNumber(coolest.mean)} °C.`;
    document.getElementById("finding-range").textContent = `${warmest.year} / ${coolest.year}`;
  }

  function renderTable(annual, overallMean) {
    elements.tableBody.replaceChildren();
    for (const point of annual) {
      const row = document.createElement("tr");
      const departure = point.mean - overallMean;
      const values = [
        String(point.year),
        Number.isFinite(point.mean) ? `${formatNumber(point.mean)} °C` : "No valid readings",
        `${point.count} / ${expectedDays(point.year)}`,
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      }
      const coverageCell = document.createElement("td");
      coverageCell.className = "coverage-cell";
      const track = document.createElement("span");
      track.className = "coverage-track";
      const fill = document.createElement("span");
      fill.className = "coverage-fill";
      fill.style.width = `${Math.max(0, Math.min(100, point.coverage * 100))}%`;
      track.appendChild(fill);
      coverageCell.append(track, document.createTextNode(`${formatNumber(point.coverage * 100, 1)}%`));
      row.appendChild(coverageCell);
      const departureCell = document.createElement("td");
      departureCell.textContent = Number.isFinite(point.mean)
        ? `${departure >= 0 ? "+" : ""}${formatNumber(departure)} °C`
        : "—";
      row.appendChild(departureCell);
      elements.tableBody.appendChild(row);
    }
  }

  function resetAnalysis() {
    missingCount = 0;
    document.getElementById("period-mean").innerHTML = `—<small>°C</small>`;
    document.getElementById("period-mean-foot").textContent = "Across valid daily observations";
    document.getElementById("trend-value").innerHTML = `—<small>°C / decade</small>`;
    document.getElementById("trend-foot").textContent = "OLS slope of annual means";
    document.getElementById("mk-result").textContent = "—";
    document.getElementById("mk-foot").textContent = "Two-sided test · α = 0.05";
    document.getElementById("valid-count").textContent = "—";
    document.getElementById("coverage-foot").textContent = "of expected observations";
    document.getElementById("finding-trend-title").textContent = "Awaiting observations";
    document.getElementById("finding-trend-copy").textContent = "The linear trend will be calculated from the annual means once NASA POWER data has loaded.";
    document.getElementById("finding-slope").textContent = "—";
    document.getElementById("finding-mk-title").textContent = "Mann–Kendall test";
    document.getElementById("finding-mk-copy").textContent = "A rank-based test evaluates whether annual temperatures show a monotonic trend; it does not assume a normal distribution.";
    document.getElementById("finding-p").textContent = "—";
    document.getElementById("finding-range-title").textContent = "Warmest & coolest years";
    document.getElementById("finding-range-copy").textContent = "The warmest and coolest annual means will be identified from available valid observations.";
    document.getElementById("finding-range").textContent = "—";
    elements.tableBody.innerHTML = '<tr><td class="table-loading" colspan="5">No data loaded. Try again to retrieve NASA POWER observations.</td></tr>';
  }

  function clearAnalysis() {
    daily = [];
    yearly = [];
    trend = null;
    resetAnalysis();
    elements.tooltip.hidden = true;
    clearChart();
  }

  async function fetchData() {
    let selection;
    try {
      selection = getSelection();
    } catch (error) {
      if (requestController) requestController.abort();
      requestController = null;
      clearAnalysis();
      elements.errorMessage.textContent = error.message;
      elements.errorPanel.hidden = false;
      elements.chartEmpty.hidden = false;
      elements.chartEmpty.textContent = "Choose a valid location and year range to load data.";
      elements.retryButton.disabled = false;
      elements.retryButton.textContent = "Try again ↻";
      elements.submitButton.textContent = "Run investigation ↗";
      setStatus("Choose a valid investigation range", "error");
      return;
    }

    if (requestController) requestController.abort();
    const controller = new AbortController();
    requestController = controller;
    updateLocationLabels(selection.location, selection.startYear, selection.endYear);
    clearAnalysis();
    setLoading(true, selection);
    elements.submitButton.textContent = "Loading NASA data…";
    try {
      const response = await fetch(makeApiUrl(selection.location, selection.startYear, selection.endYear), {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (controller.signal.aborted || requestController !== controller) return;
      if (!response.ok) {
        throw new Error(`NASA POWER responded with HTTP ${response.status}. Please try again later.`);
      }
      const payload = await response.json();
      if (controller.signal.aborted || requestController !== controller) return;
      if (payload && Array.isArray(payload.messages) && payload.messages.length > 0) {
        throw new Error(payload.messages.join(" "));
      }
      const parsed = parseDailyResponse(payload, selection.startYear, selection.endYear);
      daily = parsed.records;
      missingCount = parsed.missingCount;
      if (daily.length === 0) {
        throw new Error("NASA POWER returned no valid T2M observations for this location and year range.");
      }
      const result = summarize(daily, selection.startYear, selection.endYear);
      yearly = result.annual;
      updateMetrics(yearly, result.overallMean);
      if (controller.signal.aborted || requestController !== controller) return;
      elements.errorPanel.hidden = true;
      elements.chartEmpty.hidden = true;
      elements.retryButton.disabled = false;
      elements.retryButton.textContent = "Try again ↻";
      elements.submitButton.textContent = "Run investigation ↗";
      setStatus(`Live NASA POWER data · ${daily.length.toLocaleString()} daily values`, "");
      setView(view);
    } catch (error) {
      if (controller.signal.aborted || requestController !== controller) return;
      clearAnalysis();
      const message = error instanceof TypeError
        ? "The NASA POWER request failed. Check your internet connection and try again."
        : error instanceof Error ? error.message : "An unexpected error occurred while loading NASA POWER data.";
      elements.errorMessage.textContent = message;
      elements.errorPanel.hidden = false;
      elements.chartEmpty.hidden = false;
      elements.chartEmpty.textContent = `No data available for ${selection.location.name} until the request succeeds.`;
      elements.retryButton.disabled = false;
      elements.retryButton.textContent = "Try again ↻";
      elements.submitButton.textContent = "Run investigation ↗";
      setStatus(`NASA POWER data unavailable · ${selection.location.name}`, "error");
      clearChart();
    } finally {
      if (requestController === controller) requestController = null;
    }
  }

  function clearChart() {
    const rect = elements.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    elements.canvas.width = Math.max(1, rect.width * ratio);
    elements.canvas.height = Math.max(1, rect.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    elements.canvas.setAttribute("aria-label", "Temperature chart unavailable because NASA POWER data could not be loaded.");
  }

  function chartData() {
    return view === "annual" ? yearly.filter((item) => Number.isFinite(item.mean))
      .map((item) => ({ x: item.year, value: item.mean, label: String(item.year) }))
      : daily.map((item) => ({
        x: item.timestamp,
        value: item.value,
        label: new Date(item.timestamp).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
      }));
  }

  function drawChart() {
    if (!daily.length) return;
    const rect = elements.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    elements.canvas.width = Math.round(width * ratio);
    elements.canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const data = chartData();
    if (!data.length) return;
    const isAnnual = view === "annual";
    const padding = { top: 12, right: 18, bottom: 37, left: 47 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const values = data.map((point) => point.value);
    const minValue = Math.floor((Math.min(...values) - 0.8) * 2) / 2;
    const maxValue = Math.ceil((Math.max(...values) + 0.8) * 2) / 2;
    const xMin = data[0].x;
    const xMax = data[data.length - 1].x || xMin + 1;
    const xAt = (value) => padding.left + ((value - xMin) / (xMax - xMin || 1)) * plotWidth;
    const yAt = (value) => padding.top + ((maxValue - value) / (maxValue - minValue || 1)) * plotHeight;
    const ticks = 4;

    context.font = "10px 'DM Mono', monospace";
    context.textBaseline = "middle";
    for (let index = 0; index <= ticks; index++) {
      const value = maxValue - ((maxValue - minValue) / ticks) * index;
      const y = yAt(value);
      context.strokeStyle = "rgba(159, 185, 211, 0.12)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillStyle = "#71869c";
      context.textAlign = "right";
      context.fillText(value.toFixed(1), padding.left - 10, y);
    }

    const selection = getSelection();
    const yearTicks = isAnnual ? data.map((item) => item.x)
      : Array.from({ length: selection.endYear - selection.startYear + 1 }, (_, i) => selection.startYear + i);
    context.fillStyle = "#71869c";
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const year of yearTicks) {
      const x = isAnnual ? xAt(year) : xAt(Date.UTC(year, 0, 1));
      if (x >= padding.left - 2 && x <= width - padding.right + 2) {
        context.fillText(String(year), x, height - padding.bottom + 13);
      }
    }

    if (isAnnual) {
      const barWidth = Math.min(30, Math.max(9, plotWidth / data.length * 0.48));
      for (const item of data) {
        const x = xAt(item.x);
        const y = yAt(item.value);
        context.fillStyle = "rgba(98, 215, 236, 0.16)";
        context.fillRect(x - barWidth / 2, y, barWidth, padding.top + plotHeight - y);
        context.beginPath();
        context.arc(x, y, 3.2, 0, Math.PI * 2);
        context.fillStyle = "#62d7ec";
        context.fill();
      }
      if (trend) {
        const first = trend.intercept + trend.slope * data[0].x;
        const last = trend.intercept + trend.slope * data[data.length - 1].x;
        context.beginPath();
        context.setLineDash([5, 5]);
        context.strokeStyle = "#f0ad72";
        context.lineWidth = 1.5;
        context.moveTo(xAt(data[0].x), yAt(first));
        context.lineTo(xAt(data[data.length - 1].x), yAt(last));
        context.stroke();
        context.setLineDash([]);
      }
    } else {
      context.beginPath();
      context.strokeStyle = "#62d7ec";
      context.lineWidth = 1;
      for (let index = 0; index < data.length; index++) {
        const x = xAt(data[index].x);
        const y = yAt(data[index].value);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
      context.fillStyle = "rgba(98, 215, 236, 0.07)";
      const base = padding.top + plotHeight;
      context.lineTo(xAt(data[data.length - 1].x), base);
      context.lineTo(xAt(data[0].x), base);
      context.closePath();
      context.fill();
    }
    elements.canvas.setAttribute("aria-label", `${isAnnual ? "Annual mean" : "Daily"} T2M temperature chart, ${data.length} live NASA POWER observations, shown in degrees Celsius.`);
    elements.chartEmpty.hidden = true;
  }

  function setView(nextView) {
    view = nextView;
    const isAnnual = view === "annual";
    const location = LOCATIONS[elements.locationSelect.value];
    elements.chartTitle.textContent = `${isAnnual ? "Annual mean" : "Daily"} temperature · ${location.name.split(",")[0]}`;
    elements.legendLabel.textContent = isAnnual ? "Annual mean (°C)" : "Daily T2M (°C)";
    elements.trendLegend.hidden = !isAnnual || !trend;
    elements.chartNote.textContent = isAnnual
      ? trend
        ? "Each point is the arithmetic mean of valid daily T2M observations for that calendar year. Dashed line: ordinary least-squares fit."
        : "Each point is an annual mean. A trend line requires at least two years with valid readings."
      : "Daily T2M values from NASA POWER. Seasonal cycles and day-to-day variability are visible; no trend line is fitted to this view.";
    document.querySelectorAll(".chart-tab").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    drawChart();
    elements.tooltip.hidden = true;
  }

  function handlePointerMove(event) {
    const data = chartData();
    if (!data.length || !daily.length) return;
    const rect = elements.canvas.getBoundingClientRect();
    const padding = { left: 47, right: 18 };
    const plotWidth = rect.width - padding.left - padding.right;
    const position = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, (position - padding.left) / plotWidth));
    const index = Math.round(ratio * (data.length - 1));
    const point = data[index];
    if (!point) return;
    elements.tooltip.innerHTML = `${point.label}<strong>${formatNumber(point.value)} °C</strong>`;
    elements.tooltip.hidden = false;
    const tooltipWidth = elements.tooltip.offsetWidth;
    const left = Math.max(3, Math.min(rect.width - tooltipWidth - 3, position + 12));
    elements.tooltip.style.left = `${left}px`;
    elements.tooltip.style.top = `${Math.max(5, event.clientY - rect.top - 48)}px`;
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void fetchData();
  });
  elements.locationSelect.addEventListener("change", () => { void fetchData(); });
  elements.retryButton.addEventListener("click", () => { void fetchData(); });
  elements.canvas.addEventListener("pointermove", handlePointerMove);
  elements.canvas.addEventListener("pointerleave", () => { elements.tooltip.hidden = true; });
  document.querySelectorAll(".chart-tab").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(drawChart);
    resizeObserver.observe(elements.chartStage);
  } else {
    window.addEventListener("resize", drawChart);
  }
  void resizeObserver;
  updateLocationLabels(LOCATIONS[elements.locationSelect.value], Number(elements.startYear.value), Number(elements.endYear.value));
  void fetchData();
})();

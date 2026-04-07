import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDistance, formatDuration } from "../tools/navigation.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("navigation tools", () => {
  it("formats distances and durations for user-facing output", () => {
    expect(formatDistance(420)).toBe("420 m");
    expect(formatDistance(1520)).toBe("1.5 km");
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(780)).toBe("13 min");
    expect(formatDuration(5400)).toBe("1 h 30 min");
  });

  it("geocodes a location into candidate coordinates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        display_name: "Heraklion International Airport, Heraklion, Crete, Greece",
        lat: "35.339719",
        lon: "25.180297",
        class: "aeroway",
        type: "aerodrome",
        importance: 0.7,
      },
      {
        display_name: "Heraklion, Crete, Greece",
        lat: "35.338735",
        lon: "25.144213",
        class: "boundary",
        type: "administrative",
        importance: 0.6,
      },
    ]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("geocode_location");

    const result = await tool!.execute({ query: "Heraklion" }, {
      sessionId: "nav-1",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Multiple matches were found");
    expect(result.output).toContain("Heraklion International Airport");
    expect(result.metadata?.["ambiguous"]).toBe(true);
  });

  it("rejects postcode drift when the candidate does not match the requested postal code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        display_name: "7c, Hellerhofstraße, Dresden, Sachsen, 01129, Deutschland",
        lat: "51.0929114",
        lon: "13.7345324",
        class: "building",
        type: "apartments",
        address: {
          house_number: "7c",
          road: "Hellerhofstraße",
          city: "Dresden",
          postcode: "01129",
          country: "Deutschland",
          country_code: "de",
        },
      },
    ]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("geocode_location");

    const result = await tool!.execute({ query: "Hellerhofstraße 7c, 01109 Dresden" }, {
      sessionId: "nav-1b",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("No exact OpenStreetMap matches were found");
    expect(result.output).toContain("01129");
    expect(result.metadata?.["exactMatch"]).toBe(false);
  });

  it("rejects street mismatches instead of silently accepting nearby partial hits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        display_name: "1, Worbiser Straße, Breitenbach, Leinefelde-Worbis, Landkreis Eichsfeld, Thüringen, 37327, Deutschland",
        lat: "51.4036039",
        lon: "10.3374814",
        class: "building",
        type: "yes",
        address: {
          house_number: "1",
          road: "Worbiser Straße",
          city: "Leinefelde-Worbis",
          postcode: "37327",
          country: "Deutschland",
          country_code: "de",
        },
      },
      {
        display_name: "Eichsfelder Baumschulen & Gartenservice, 1, Hauptstraße, Niederorschel, Leinefelde-Worbis, Landkreis Eichsfeld, Thüringen, 37355, Deutschland",
        lat: "51.3655531",
        lon: "10.4239046",
        class: "craft",
        type: "gardener",
        address: {
          house_number: "1",
          road: "Hauptstraße",
          village: "Niederorschel",
          municipality: "Leinefelde-Worbis",
          postcode: "37355",
          country: "Deutschland",
          country_code: "de",
        },
      },
    ]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("geocode_location");

    const result = await tool!.execute({ query: "Hauptstraße 1, 37327 Worbis" }, {
      sessionId: "nav-1c",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("No exact OpenStreetMap matches were found");
    expect(result.output).toContain("Worbiser Straße");
    expect(result.output).toContain("Hauptstraße");
    expect(result.metadata?.["exactMatch"]).toBe(false);
  });

  it("routes between coordinates for car and walking mode", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isDriving = url.includes("/driving/");
      return new Response(JSON.stringify({
        code: "Ok",
        routes: [{
          distance: isDriving ? 25500 : 23100,
          duration: isDriving ? 1440 : 17160,
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("route_distance_time");

    const driving = await tool!.execute({
      fromLat: 35.339719,
      fromLon: 25.180297,
      toLat: 35.406992,
      toLon: 24.985968,
      mode: "car",
    }, {
      sessionId: "nav-2",
      workspacePath: "/workspace",
    });

    const walking = await tool!.execute({
      fromLat: 35.339719,
      fromLon: 25.180297,
      toLat: 35.406992,
      toLon: 24.985968,
      mode: "walking",
    }, {
      sessionId: "nav-3",
      workspacePath: "/workspace",
    });

    expect(driving.success).toBe(true);
    expect(driving.output).toContain("Mode: car");
    expect(driving.output).toContain("Distance: 26 km");
    expect(driving.output).toContain("Estimated travel time: 24 min");

    expect(walking.success).toBe(true);
    expect(walking.output).toContain("Mode: walking");
    expect(walking.output).toContain("Estimated travel time: 4 h 46 min");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const { getTechnicianIdsBySupervisorMock } = vi.hoisted(() => ({
  getTechnicianIdsBySupervisorMock: vi.fn(),
}));

vi.mock("@server/composition/supervisor-assignments.container", () => ({
  supervisorAssignmentsContainer: {
    supervisorAssignmentsUseCase: {
      getTechnicianIdsBySupervisor: getTechnicianIdsBySupervisorMock,
    },
  },
}));

import { requireTechnicianScope } from "./technician-scope.middleware";

function mockReqRes(user: { id: string; role: string }, technicianId: string) {
  const req = { user, params: { technicianId } } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, status, json, next };
}

describe("requireTechnicianScope — full authorization matrix", () => {
  beforeEach(() => {
    getTechnicianIdsBySupervisorMock.mockReset();
  });

  it("Technician reads/edits own custody -> PASS (next called, no DB lookup needed)", async () => {
    const { req, res, next } = mockReqRes({ id: "tech-A", role: "technician" }, "tech-A");
    await requireTechnicianScope(req, res, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getTechnicianIdsBySupervisorMock).not.toHaveBeenCalled();
  });

  it("Technician reads another technician's custody -> DENIED (403)", async () => {
    const { req, res, status, json, next } = mockReqRes({ id: "tech-A", role: "technician" }, "tech-B");
    await requireTechnicianScope(req, res, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ message: "غير مصرح لك بالوصول لهذا المورد" });
  });

  it("Technician edits another technician's custody -> DENIED (403), same guard path as read", async () => {
    const { req, res, status, next } = mockReqRes({ id: "tech-A", role: "technician" }, "tech-C");
    await requireTechnicianScope(req, res, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("Admin -> PASS regardless of technicianId (per their permissions, no scope lookup needed)", async () => {
    const { req, res, next } = mockReqRes({ id: "admin-1", role: "admin" }, "tech-anyone");
    await requireTechnicianScope(req, res, next as any);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getTechnicianIdsBySupervisorMock).not.toHaveBeenCalled();
  });

  it("Supervisor WITHIN their actual assigned scope -> PASS", async () => {
    getTechnicianIdsBySupervisorMock.mockResolvedValue(["tech-X", "tech-Y"]);
    const { req, res, next } = mockReqRes({ id: "sup-1", role: "supervisor" }, "tech-Y");
    await requireTechnicianScope(req, res, next as any);
    expect(getTechnicianIdsBySupervisorMock).toHaveBeenCalledWith("sup-1");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("Supervisor OUTSIDE their actual assigned scope -> DENIED (403), real scope checked not just role", async () => {
    getTechnicianIdsBySupervisorMock.mockResolvedValue(["tech-X", "tech-Y"]);
    const { req, res, status, json, next } = mockReqRes({ id: "sup-1", role: "supervisor" }, "tech-Z");
    await requireTechnicianScope(req, res, next as any);
    expect(getTechnicianIdsBySupervisorMock).toHaveBeenCalledWith("sup-1");
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ message: "غير مصرح لك بالوصول لهذا المورد" });
  });

  it("Supervisor with NO assignments at all -> DENIED for any technician", async () => {
    getTechnicianIdsBySupervisorMock.mockResolvedValue([]);
    const { req, res, status, next } = mockReqRes({ id: "sup-2", role: "supervisor" }, "tech-anyone");
    await requireTechnicianScope(req, res, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("Changing technicianId in the URL does not bypass authorization (explicit): same technician account, two different URL params -> one PASS, one DENIED", async () => {
    const callSelf = mockReqRes({ id: "tech-A", role: "technician" }, "tech-A");
    await requireTechnicianScope(callSelf.req, callSelf.res, callSelf.next as any);
    expect(callSelf.next).toHaveBeenCalledTimes(1);

    const callOther = mockReqRes({ id: "tech-A", role: "technician" }, "tech-B");
    await requireTechnicianScope(callOther.req, callOther.res, callOther.next as any);
    expect(callOther.next).not.toHaveBeenCalled();
    expect(callOther.status).toHaveBeenCalledWith(403);
  });

  it("An unrecognized/other role (not technician/supervisor/admin) is DENIED even for their own id-looking param", async () => {
    const { req, res, status, next } = mockReqRes({ id: "x-1", role: "guest" }, "tech-other");
    await requireTechnicianScope(req, res, next as any);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});

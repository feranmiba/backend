it('rejects confirm after the reservation expired', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const { reservationId } = await service.reserve(chainEventId /* , ... */);

  jest.setSystemTime(new Date('2026-01-01T01:00:00Z')); // past the TTL
  await expect(service.confirm(chainEventId, reservationId)).rejects.toThrow(ConflictException);
  jest.useRealTimers();
});

it('rejects a stale holder after someone else re-reserved the id', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const a = await service.reserve(chainEventId);
  jest.setSystemTime(new Date('2026-01-01T01:00:00Z')); // A expires
  const b = await service.reserve(chainEventId);        // B reuses the id

  await expect(service.confirm(chainEventId, a.reservationId)).rejects.toThrow(ConflictException);
  await expect(service.confirm(chainEventId, b.reservationId)).resolves.toBeDefined();
  jest.useRealTimers();
});

async hasPendingReservation(chainEventId: string, reservationId: string): Promise<boolean> {
  const r = await this.findReservation(chainEventId); // <- your existing lookup (repo/map/query)
  if (!r) return false;
  return (
    r.reservationId === reservationId &&   // same holder, not someone who re-reserved after expiry
    r.status === 'pending' &&              // not already confirmed or released
    r.expiresAt.getTime() > Date.now()     // not expired
  );
}

it('confirms a live reservation', async () => {
  const { reservationId } = await service.reserve(chainEventId);
  await expect(service.confirm(chainEventId, reservationId)).resolves.toBeDefined();
});

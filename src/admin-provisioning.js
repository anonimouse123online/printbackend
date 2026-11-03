/** Provision the first administrator while serializing concurrent CLI attempts. */
export async function provisionInitialAdmin({ db, email, passwordHash }) {
  return db.$transaction(async tx => {
    const lockRows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('printready-initial-admin')) AS locked`;
    if (lockRows[0]?.locked !== true) {
      throw new Error('Another initial administrator provisioning attempt is in progress. No account was changed.');
    }

    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.role === 'ADMIN') throw new Error('An administrator already exists with that email. No account was changed.');
      throw new Error('That email already belongs to a non-admin account. It was not promoted or changed.');
    }
    if (await tx.user.count({ where: { role: 'ADMIN' } })) throw new Error('An administrator already exists. One-time provisioning made no changes.');
    const user = await tx.user.create({ data: { email, fullName: 'PrintReady Administrator', passwordHash, role: 'ADMIN' } });
    await tx.auditLog.create({ data: { actorId: user.id, action: 'INITIAL_ADMIN_PROVISIONED', entityType: 'user', entityId: user.id } });
    return user;
  }, { isolationLevel: 'ReadCommitted' });
}

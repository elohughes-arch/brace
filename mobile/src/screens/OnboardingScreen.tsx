import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { colors, space, radius, type as T } from '../theme';
import { Card, Button } from '../components/ui';
import { useAuth } from '../lib/auth';
import { updateProfile } from '../lib/api';

type IconName = React.ComponentProps<typeof Feather>['name'];

const STEPS = ['age', 'safety', 'permission', 'disclaimer'] as const;
type Step = typeof STEPS[number];

// ── A re-usable checkbox row ─────────────────────────────────────────────────
function CheckRow({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <Pressable onPress={onToggle} style={({ pressed }) => [s.check, pressed && { opacity: 0.85 }]}>
      <View style={[s.box, checked && s.boxOn]}>
        {checked ? <Feather name="check" size={15} color={colors.onPrimary} /> : null}
      </View>
      <Text style={s.checkText}>{children}</Text>
    </Pressable>
  );
}

function StepHeader({ icon, title, subtitle }: { icon: IconName; title: string; subtitle: string }) {
  return (
    <View style={{ marginBottom: space.xl }}>
      <View style={s.stepIcon}>
        <Feather name={icon} size={26} color={colors.primary} />
      </View>
      <Text style={[T.h1, { marginTop: space.lg }]}>{title}</Text>
      <Text style={[T.bodyMuted, { marginTop: space.sm }]}>{subtitle}</Text>
    </View>
  );
}

export default function OnboardingScreen() {
  const { user, refreshProfile } = useAuth();
  const [stepIndex, setStepIndex] = useState(0);
  const step: Step = STEPS[stepIndex];

  const [ageOk, setAgeOk] = useState(false);
  const [eyewearOk, setEyewearOk] = useState(false);
  const [cameraAck, setCameraAck] = useState(false);

  const [permStatus, setPermStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle');

  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = useCallback(() => setStepIndex(i => Math.min(i + 1, STEPS.length - 1)), []);
  const back = useCallback(() => setStepIndex(i => Math.max(i - 1, 0)), []);

  const requestPermission = useCallback(async () => {
    setPermStatus('requesting');
    try {
      const res = await MediaLibrary.requestPermissionsAsync();
      setPermStatus(res.granted ? 'granted' : 'denied');
    } catch {
      setPermStatus('denied');
    }
  }, []);

  const finish = useCallback(async () => {
    if (!user) { setError('No active session. Please sign in again.'); return; }
    setError(null);
    setFinishing(true);
    try {
      await updateProfile(user.id, { age_verified: true, eyewear_confirmed: true, onboarded: true });
      await refreshProfile();
      // Navigation root re-renders into the app once profile.onboarded flips true.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Please try again.');
      setFinishing(false);
    }
  }, [user, refreshProfile]);

  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      {/* Progress indicator */}
      <View style={s.progressRow}>
        {STEPS.map((_, i) => (
          <View key={i} style={[s.progressSeg, i <= stepIndex ? s.progressOn : s.progressOff]} />
        ))}
      </View>
      <View style={s.topBar}>
        {stepIndex > 0 ? (
          <Pressable onPress={back} hitSlop={10} style={s.backBtn}>
            <Feather name="chevron-left" size={20} color={colors.textMuted} />
            <Text style={s.backText}>Back</Text>
          </Pressable>
        ) : <View />}
        <Text style={s.stepCount}>{stepIndex + 1} / {STEPS.length}</Text>
      </View>

      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── (a) Age gate ──────────────────────────────────────────────── */}
        {step === 'age' && (
          <>
            <StepHeader
              icon="user-check"
              title="Confirm your age"
              subtitle="Brace involves live sport shooting. You must be 18 or older to use the app."
            />
            <Card>
              <CheckRow checked={ageOk} onToggle={() => setAgeOk(v => !v)}>
                I confirm that I am 18 years of age or older.
              </CheckRow>
            </Card>
            <Button title="Continue" onPress={next} disabled={!ageOk} style={s.cta} />
          </>
        )}

        {/* ── (b) Safety acknowledgement ────────────────────────────────── */}
        {step === 'safety' && (
          <>
            <StepHeader
              icon="shield"
              title="Eye protection"
              subtitle="Live shooting demands certified eye protection. This is a safety requirement, separate from any camera you film with."
            />
            <Card style={{ marginBottom: space.lg }}>
              <Text style={s.cardLead}>Always wear shooting glasses rated to:</Text>
              <View style={s.badgeRow}>
                <View style={s.stdBadge}><Text style={s.stdText}>EN 166</Text></View>
                <View style={s.stdBadge}><Text style={s.stdText}>ANSI Z87+</Text></View>
              </View>
              <Text style={s.cardBody}>
                Certified safety eyewear protects against fragments, ricochets and debris on the line. Standard
                sunglasses or fashion frames are not a substitute.
              </Text>
            </Card>

            <Card style={{ marginBottom: space.lg }}>
              <Text style={s.cardLead}>Filming your shots</Text>
              <Text style={s.cardBody}>
                We recommend the Oakley Meta Vanguard for hands-free capture. Camera compatibility is a separate
                consideration: confirm any camera eyewear independently meets EN 166 / ANSI Z87+ before relying on it
                for impact protection on the line.
              </Text>
            </Card>

            <Card>
              <CheckRow checked={eyewearOk} onToggle={() => setEyewearOk(v => !v)}>
                I will wear eye protection certified to EN 166 / ANSI Z87+ whenever I shoot live.
              </CheckRow>
            </Card>
            <Button title="Continue" onPress={next} disabled={!eyewearOk} style={s.cta} />
          </>
        )}

        {/* ── (c) Photo-library permission ──────────────────────────────── */}
        {step === 'permission' && (
          <>
            <StepHeader
              icon="film"
              title="Access your clips"
              subtitle="Brace imports the video you've already filmed, then analyses it for shots, hits and accuracy."
            />
            <Card style={{ marginBottom: space.lg }}>
              <Text style={s.cardBody}>
                Your footage lands in your camera roll. We use the system picker so you choose exactly which clip to
                import — nothing is uploaded or read automatically. Granting photo-library access lets the picker
                open and lets us load the clip you select.
              </Text>
            </Card>

            {permStatus === 'granted' ? (
              <View style={[s.permState, { borderColor: colors.primary + '55', backgroundColor: colors.primary + '14' }]}>
                <Feather name="check-circle" size={18} color={colors.primary} />
                <Text style={[s.permStateText, { color: colors.primary }]}>Access granted — you're ready to import.</Text>
              </View>
            ) : permStatus === 'denied' ? (
              <View style={[s.permState, { borderColor: colors.amber + '55', backgroundColor: colors.amber + '14' }]}>
                <Feather name="alert-triangle" size={18} color={colors.amber} />
                <Text style={[s.permStateText, { color: colors.amber }]}>
                  Access not granted. You can enable it later in Settings, or the system picker will prompt you on
                  first import.
                </Text>
              </View>
            ) : null}

            {permStatus === 'granted' || permStatus === 'denied' ? (
              <Button title="Continue" onPress={next} style={s.cta} />
            ) : (
              <>
                <Button
                  title="Allow photo access"
                  icon="image"
                  onPress={requestPermission}
                  loading={permStatus === 'requesting'}
                  style={s.cta}
                />
                <Button title="Skip for now" variant="ghost" onPress={next} style={{ marginTop: space.xs }} />
              </>
            )}
          </>
        )}

        {/* ── (d) Disclaimer + Get Started ──────────────────────────────── */}
        {step === 'disclaimer' && (
          <>
            <StepHeader
              icon="info"
              title="One last thing"
              subtitle="A quick note before you start tracking your shooting."
            />
            <Card style={{ marginBottom: space.lg }}>
              <Text style={s.cardBody}>
                Brace is an independent app. We are not affiliated with, endorsed by, or sponsored by Meta, Oakley,
                Ray-Ban, or any eyewear or camera manufacturer. Product names are mentioned only to describe
                compatible hardware.
              </Text>
            </Card>
            <Card>
              <Text style={s.cardLead}>You're set</Text>
              <Text style={s.cardBody}>
                Film a stand, import the clip, and Brace breaks it down shot by shot. Welcome aboard, founding member.
              </Text>
            </Card>

            {error ? (
              <View style={s.error}>
                <Feather name="alert-circle" size={15} color={colors.red} />
                <Text style={s.errorText}>{error}</Text>
              </View>
            ) : null}

            <Button title="Get started" onPress={finish} loading={finishing} style={s.cta} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  progressRow: { flexDirection: 'row', gap: 6, paddingHorizontal: space.lg, paddingTop: space.md },
  progressSeg: { flex: 1, height: 4, borderRadius: 2 },
  progressOn: { backgroundColor: colors.primary },
  progressOff: { backgroundColor: colors.border },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 40 },
  backBtn: { flexDirection: 'row', alignItems: 'center' },
  backText: { ...T.label, fontSize: 12, color: colors.textMuted },
  stepCount: { ...T.label, fontSize: 11, color: colors.textDim },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.huge, paddingTop: space.sm },
  stepIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary + '1A', borderWidth: 1, borderColor: colors.primary + '44', alignItems: 'center', justifyContent: 'center' },
  cardLead: { ...T.h3, marginBottom: space.sm },
  cardBody: { ...T.bodyMuted, lineHeight: 22 },
  badgeRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  stdBadge: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 6 },
  stdText: { ...T.label, fontSize: 12, color: colors.text },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  box: { width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkText: { flex: 1, ...T.body, lineHeight: 22 },
  permState: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.lg, marginBottom: space.lg },
  permStateText: { flex: 1, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  cta: { marginTop: space.xl },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.red + '14', borderColor: colors.red + '40', borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md, marginTop: space.lg },
  errorText: { flex: 1, color: colors.red, fontSize: 13, fontWeight: '500' },
});

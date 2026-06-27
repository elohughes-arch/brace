import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { colors, space, radius, type as T } from '../theme';
import { Card, Field, Button } from '../components/ui';
import { useAuth } from '../lib/auth';

function friendlyError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e || '')).toLowerCase();
  if (msg.includes('invalid login') || msg.includes('invalid credentials')) return 'Email or password is incorrect.';
  if (msg.includes('already registered') || msg.includes('already been registered')) return 'That email already has an account. Try signing in.';
  if (msg.includes('password')) return 'Password must be at least 6 characters.';
  if (msg.includes('email')) return 'Please enter a valid email address.';
  if (msg.includes('network') || msg.includes('fetch')) return 'Network error. Check your connection and try again.';
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.';
}

export default function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const isSignup = mode === 'signup';

  const toggle = useCallback(() => {
    setError(null);
    setMode(m => (m === 'signin' ? 'signup' : 'signin'));
  }, []);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (!email.trim()) { setError('Please enter your email address.'); return; }
    if (!password) { setError('Please enter your password.'); return; }
    if (isSignup && !name.trim()) { setError('Please enter your name.'); return; }
    setLoading(true);
    try {
      if (isSignup) {
        const { needsConfirm } = await signUp(email, password, name.trim());
        if (needsConfirm) { setSentTo(email.trim()); }
        // if no confirmation needed, the auth listener routes us onward automatically.
      } else {
        await signIn(email, password);
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [email, password, name, isSignup, signIn, signUp]);

  // ── "Check your inbox" state ───────────────────────────────────────────────
  if (sentTo) {
    return (
      <SafeAreaView style={s.screen}>
        <View style={s.centered}>
          <Card style={s.card}>
            <View style={s.inboxIcon}>
              <Feather name="mail" size={30} color={colors.primary} />
            </View>
            <Text style={[T.h2, { textAlign: 'center', marginTop: space.lg }]}>Check your inbox</Text>
            <Text style={[T.bodyMuted, { textAlign: 'center', marginTop: space.sm }]}>
              We sent a confirmation link to{'\n'}
              <Text style={{ color: colors.text, fontWeight: '700' }}>{sentTo}</Text>
            </Text>
            <Text style={[T.small, { textAlign: 'center', marginTop: space.md }]}>
              Tap the link to verify your email, then come back and sign in.
            </Text>
            <Button
              title="Back to sign in"
              variant="outline"
              style={{ marginTop: space.xl }}
              onPress={() => { setSentTo(null); setMode('signin'); setPassword(''); }}
            />
          </Card>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Wordmark + tagline */}
          <View style={s.brand}>
            <Text style={s.wordmark}>BRACE</Text>
            <Text style={s.tagline}>Film the shot. See the miss. Close the gap.</Text>
          </View>

          <Card style={s.card}>
            {/* Mode toggle */}
            <View style={s.segment}>
              <Pressable
                style={[s.segItem, !isSignup && s.segItemActive]}
                onPress={() => { if (isSignup) toggle(); }}
              >
                <Text style={[s.segText, !isSignup && s.segTextActive]}>Sign in</Text>
              </Pressable>
              <Pressable
                style={[s.segItem, isSignup && s.segItemActive]}
                onPress={() => { if (!isSignup) toggle(); }}
              >
                <Text style={[s.segText, isSignup && s.segTextActive]}>Create account</Text>
              </Pressable>
            </View>

            {isSignup && (
              <Field
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="Your name"
                autoCapitalize="words"
              />
            )}
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder={isSignup ? 'At least 6 characters' : 'Your password'}
              secureTextEntry
              autoCapitalize="none"
            />

            {error ? (
              <View style={s.error}>
                <Feather name="alert-circle" size={15} color={colors.red} />
                <Text style={s.errorText}>{error}</Text>
              </View>
            ) : null}

            <Button
              title={isSignup ? 'Create account' : 'Sign in'}
              onPress={onSubmit}
              loading={loading}
              style={{ marginTop: space.sm }}
            />

            <Pressable onPress={toggle} hitSlop={8} style={{ marginTop: space.lg, alignSelf: 'center' }}>
              <Text style={s.switch}>
                {isSignup ? 'Already have an account? ' : 'New to Brace? '}
                <Text style={{ color: colors.primary, fontWeight: '700' }}>
                  {isSignup ? 'Sign in' : 'Create one'}
                </Text>
              </Text>
            </Pressable>
          </Card>

          <Text style={s.founder}>Founding member · Pre-launch access</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.xl, paddingVertical: space.huge },
  centered: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xl },
  brand: { alignItems: 'center', marginBottom: space.xxxl },
  wordmark: { fontSize: 46, fontWeight: '800', color: colors.text, letterSpacing: 6 },
  tagline: { ...T.bodyMuted, marginTop: space.sm, textAlign: 'center' },
  card: { padding: space.xl },
  segment: { flexDirection: 'row', backgroundColor: colors.bgElevated, borderRadius: radius.pill, padding: 4, marginBottom: space.xl },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: radius.pill, alignItems: 'center' },
  segItemActive: { backgroundColor: colors.cardAlt },
  segText: { ...T.label, fontSize: 11, color: colors.textMuted },
  segTextActive: { color: colors.text },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.red + '14', borderColor: colors.red + '40', borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md, marginBottom: space.lg },
  errorText: { flex: 1, color: colors.red, fontSize: 13, fontWeight: '500' },
  switch: { ...T.small, color: colors.textMuted },
  inboxIcon: { alignSelf: 'center', width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primary + '1A', borderWidth: 1, borderColor: colors.primary + '44', alignItems: 'center', justifyContent: 'center' },
  founder: { ...T.label, fontSize: 10, textAlign: 'center', marginTop: space.xl, color: colors.textDim },
});

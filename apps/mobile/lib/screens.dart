import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import 'api.dart';
import 'app.dart';
import 'models.dart';

const uploadQueueGroup = 'nss-uploads';
final uploadQueueUpdates = StreamController<TaskUpdate>.broadcast();
bool _uploadCallbacksConfigured = false;

void configureUploadQueueCallbacks() {
  if (_uploadCallbacksConfigured) return;
  _uploadCallbacksConfigured = true;
  FileDownloader().registerCallbacks(
    group: uploadQueueGroup,
    taskStatusCallback: (update) => uploadQueueUpdates.add(update),
    taskProgressCallback: (update) => uploadQueueUpdates.add(update),
  );
}

extension ApiContext on BuildContext {
  AppController get app => ProviderScope.containerOf(
    this,
    listen: false,
  ).read(appControllerProvider);
  ApiClient get api => app.api;
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.child});

  final Widget child;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  static const destinations = [
    '/home',
    '/events',
    '/uploads',
    '/inbox',
    '/profile',
  ];

  int get selected {
    final index = destinations.indexWhere(
      (path) => GoRouterState.of(context).uri.path.startsWith(path),
    );
    return index.clamp(0, destinations.length - 1).toInt();
  }

  @override
  Widget build(BuildContext context) {
    final user = context.app.state.user!;
    return Scaffold(
      body: SafeArea(child: widget.child),
      bottomNavigationBar: NavigationBar(
        selectedIndex: selected,
        onDestinationSelected: (index) => context.go(destinations[index]),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: 'Home',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_outlined),
            selectedIcon: Icon(Icons.event),
            label: 'Events',
          ),
          NavigationDestination(
            icon: Icon(Icons.cloud_upload_outlined),
            selectedIcon: Icon(Icons.cloud_upload),
            label: 'Uploads',
          ),
          NavigationDestination(
            icon: Icon(Icons.inbox_outlined),
            selectedIcon: Icon(Icons.inbox),
            label: 'Inbox',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
      floatingActionButton:
          user.role == UserRole.approver || user.role == UserRole.admin
          ? FloatingActionButton.extended(
              onPressed: () => context.push('/review'),
              icon: const Icon(Icons.photo_library_outlined),
              label: const Text('Review'),
            )
          : null,
    );
  }
}

class PageFrame extends StatelessWidget {
  const PageFrame({
    super.key,
    required this.title,
    required this.child,
    this.action,
  });

  final String title;
  final Widget child;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(title),
      actions: action == null ? null : [action!],
    ),
    body: child,
  );
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final email = TextEditingController();
  final password = TextEditingController();
  bool busy = false;
  String? error;

  @override
  void dispose() {
    email.dispose();
    password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AuthScaffold(
    title: 'Welcome back',
    subtitle: 'Sign in with your verified institutional account.',
    child: Form(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            controller: email,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(
              labelText: 'Institutional email',
              prefixIcon: Icon(Icons.alternate_email),
            ),
          ),
          const SizedBox(height: 14),
          TextFormField(
            controller: password,
            obscureText: true,
            onFieldSubmitted: (_) => _submit(),
            decoration: const InputDecoration(
              labelText: 'Password',
              prefixIcon: Icon(Icons.lock_outline),
            ),
          ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: busy ? null : () => context.go('/forgot-password'),
              child: const Text('Forgot password?'),
            ),
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: busy ? null : _submit,
            child: Text(busy ? 'Signing in…' : 'Sign in'),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: busy ? null : () => context.go('/register'),
            child: const Text('Create an account'),
          ),
        ],
      ),
    ),
  );

  Future<void> _submit() async {
    if (email.text.trim().isEmpty || password.text.isEmpty) {
      setState(() => error = 'Enter your institutional email and password.');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await context.app.login(email.text.trim(), password.text);
      if (mounted) context.go('/home');
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } catch (_) {
      if (mounted)
        setState(
          () =>
              error = 'Unable to sign in. Check your connection and try again.',
        );
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final email = TextEditingController();
  String? message;
  String? error;
  bool busy = false;

  @override
  void dispose() {
    email.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AuthScaffold(
    title: 'Reset password',
    subtitle: 'We will send a time-limited link if the address is eligible.',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: email,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Institutional email'),
        ),
        const SizedBox(height: 18),
        if (message != null)
          Text(message!, style: const TextStyle(color: Color(0xff347a58))),
        if (error != null)
          Text(
            error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        FilledButton(
          onPressed: busy ? null : _submit,
          child: Text(busy ? 'Sending…' : 'Send reset link'),
        ),
        TextButton(
          onPressed: () => context.go('/login'),
          child: const Text('Back to sign in'),
        ),
      ],
    ),
  );

  Future<void> _submit() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await context.api.forgotPassword(email.text.trim());
      if (mounted)
        setState(
          () => message = 'If the address is eligible, check your inbox.',
        );
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class VerifyEmailScreen extends StatelessWidget {
  const VerifyEmailScreen({super.key});

  @override
  Widget build(BuildContext context) => AuthScaffold(
    title: 'Verify your email',
    subtitle:
        'Open the verification link sent to your exact @iiitnr.edu.in address, then return here to sign in.',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.mark_email_read_outlined, size: 50),
        const SizedBox(height: 18),
        const Text(
          'Verification links expire after 24 hours. Check your spam or institutional quarantine folder before requesting another account.',
        ),
        const SizedBox(height: 18),
        FilledButton(
          onPressed: () => context.go('/login'),
          child: const Text('Back to sign in'),
        ),
      ],
    ),
  );
}

class ResetPasswordScreen extends StatefulWidget {
  const ResetPasswordScreen({super.key, required this.token});

  final String token;

  @override
  State<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends State<ResetPasswordScreen> {
  final password = TextEditingController();
  String? message;
  String? error;
  bool busy = false;

  @override
  void dispose() {
    password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AuthScaffold(
    title: 'Choose a new password',
    subtitle:
        'Use at least 12 characters. All existing browser and mobile sessions will be revoked.',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: password,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'New password'),
        ),
        const SizedBox(height: 18),
        if (message != null)
          Text(message!, style: const TextStyle(color: Color(0xff347a58))),
        if (error != null)
          Text(
            error!,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        FilledButton(
          onPressed: busy || widget.token.isEmpty ? null : _submit,
          child: Text(busy ? 'Saving…' : 'Reset password'),
        ),
        if (message != null)
          TextButton(
            onPressed: () => context.go('/login'),
            child: const Text('Return to sign in'),
          ),
      ],
    ),
  );

  Future<void> _submit() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await context.api.resetPassword(widget.token, password.text);
      if (mounted)
        setState(() => message = 'Password reset. Return to sign in.');
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final name = TextEditingController();
  final email = TextEditingController();
  final password = TextEditingController();
  String? message;
  String? error;
  bool busy = false;

  @override
  void dispose() {
    name.dispose();
    email.dispose();
    password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AuthScaffold(
    title: 'Join the unit',
    subtitle:
        'Use your exact @iiitnr.edu.in address. Verification is required before sign in.',
    child: Form(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            controller: name,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          const SizedBox(height: 14),
          TextFormField(
            controller: email,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(labelText: 'Institutional email'),
          ),
          const SizedBox(height: 14),
          TextFormField(
            controller: password,
            obscureText: true,
            decoration: const InputDecoration(
              labelText: 'Password · 12 characters minimum',
            ),
          ),
          if (message != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Text(
                message!,
                style: const TextStyle(color: Color(0xff347a58)),
              ),
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 22),
          FilledButton(
            onPressed: busy ? null : _submit,
            child: Text(busy ? 'Creating…' : 'Create account'),
          ),
          TextButton(
            onPressed: () => context.go('/login'),
            child: const Text('Already have an account? Sign in'),
          ),
        ],
      ),
    ),
  );

  Future<void> _submit() async {
    if (name.text.trim().isEmpty ||
        email.text.trim().isEmpty ||
        password.text.length < 12) {
      setState(
        () => error =
            'Enter your name, institutional email, and a password of at least 12 characters.',
      );
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await context.app.register(
        name.text.trim(),
        email.text.trim(),
        password.text,
      );
      if (mounted)
        setState(
          () => message =
              'Account created. Open the verification link sent to your institutional inbox.',
        );
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class AuthScaffold extends StatelessWidget {
  const AuthScaffold({
    super.key,
    required this.title,
    required this.subtitle,
    required this.child,
  });

  final String title;
  final String subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const BrandMark(),
                const SizedBox(height: 34),
                Text(title, style: Theme.of(context).textTheme.headlineLarge),
                const SizedBox(height: 8),
                Text(subtitle),
                const SizedBox(height: 28),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: child,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class BrandMark extends StatelessWidget {
  const BrandMark({super.key});

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Container(
        width: 46,
        height: 46,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primary,
          shape: BoxShape.circle,
        ),
        alignment: Alignment.center,
        child: const Text(
          'N',
          style: TextStyle(
            color: Colors.white,
            fontSize: 24,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
      const SizedBox(width: 12),
      const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'NSS Studio',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
          ),
          Text('IIIT Naya Raipur'),
        ],
      ),
    ],
  );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<List<EventRecord>> future;

  @override
  void initState() {
    super.initState();
    future = context.api.events();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title:
        'Good to see you, ${context.app.state.user!.displayName.split(' ').first}.',
    child: RefreshIndicator(
      onRefresh: () async => setState(() => future = context.api.events()),
      child: FutureBuilder<List<EventRecord>>(
        future: future,
        builder: (context, snapshot) {
          if (snapshot.hasError)
            return ErrorState(
              message: snapshot.error.toString(),
              retry: () => setState(() => future = context.api.events()),
            );
          if (!snapshot.hasData) return const LoadingState();
          final events = snapshot.data!;
          return ListView(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
            children: [
              Text(
                'Service, in motion.',
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 8),
              const Text(
                'Find a date, contribute a photograph, and keep the public story alive.',
              ),
              const SizedBox(height: 24),
              SectionTitle(
                title: 'Next dates',
                action: TextButton(
                  onPressed: () => context.go('/events'),
                  child: const Text('See all'),
                ),
              ),
              if (events.isEmpty)
                const EmptyState(
                  title: 'No published events yet',
                  message:
                      'When the unit publishes a date, it will appear here.',
                )
              else
                ...events.take(4).map((event) => EventTile(event: event)),
              const SizedBox(height: 18),
              Card(
                child: ListTile(
                  leading: const Icon(Icons.add_a_photo_outlined),
                  title: const Text('Share a moment'),
                  subtitle: const Text(
                    'Upload photographs from a published event.',
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.go('/uploads'),
                ),
              ),
            ],
          );
        },
      ),
    ),
  );
}

class EventsScreen extends StatefulWidget {
  const EventsScreen({super.key});

  @override
  State<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends State<EventsScreen> {
  late Future<List<EventRecord>> future;
  final search = TextEditingController();

  @override
  void initState() {
    super.initState();
    future = context.api.events();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Events',
    action: IconButton(
      onPressed: () =>
          setState(() => future = context.api.events(query: search.text)),
      icon: const Icon(Icons.refresh),
      tooltip: 'Refresh events',
    ),
    child: Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
          child: TextField(
            controller: search,
            onSubmitted: (_) =>
                setState(() => future = context.api.events(query: search.text)),
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Search events',
            ),
          ),
        ),
        Expanded(
          child: FutureBuilder<List<EventRecord>>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.hasError)
                return ErrorState(
                  message: snapshot.error.toString(),
                  retry: () => setState(() => future = context.api.events()),
                );
              if (!snapshot.hasData) return const LoadingState();
              if (snapshot.data!.isEmpty)
                return const EmptyState(
                  title: 'No events found',
                  message:
                      'Try another search or check back after the unit publishes a date.',
                );
              return ListView.separated(
                padding: const EdgeInsets.all(20),
                itemCount: snapshot.data!.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (_, index) =>
                    EventTile(event: snapshot.data![index]),
              );
            },
          ),
        ),
      ],
    ),
  );
}

class EventDetailScreen extends StatefulWidget {
  const EventDetailScreen({super.key, required this.slug});

  final String slug;

  @override
  State<EventDetailScreen> createState() => _EventDetailScreenState();
}

class _EventDetailScreenState extends State<EventDetailScreen> {
  late Future<EventRecord> future;

  @override
  void initState() {
    super.initState();
    future = context.api.event(widget.slug);
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<EventRecord>(
    future: future,
    builder: (context, snapshot) {
      if (snapshot.hasError)
        return PageFrame(
          title: 'Event',
          child: ErrorState(
            message: snapshot.error.toString(),
            retry: () =>
                setState(() => future = context.api.event(widget.slug)),
          ),
        );
      if (!snapshot.hasData)
        return const PageFrame(title: 'Event', child: LoadingState());
      final event = snapshot.data!;
      final canUpload = uploadWindowIsOpen(event, DateTime.now());
      return PageFrame(
        title: event.title,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 32),
          children: [
            if (event.coverUrl != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(18),
                child: CachedNetworkImage(
                  imageUrl: context.api.absoluteUrl(event.coverUrl!),
                  height: 230,
                  fit: BoxFit.cover,
                  placeholder: (_, __) =>
                      const ColoredBox(color: Color(0xffe0dbce)),
                  errorWidget: (_, __, ___) => const SizedBox.shrink(),
                ),
              ),
            const SizedBox(height: 20),
            Text(
              event.category.toUpperCase(),
              style: TextStyle(
                color: Theme.of(context).colorScheme.primary,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
              ),
            ),
            const SizedBox(height: 8),
            Text(event.title, style: Theme.of(context).textTheme.headlineLarge),
            const SizedBox(height: 12),
            Text(event.summary),
            const SizedBox(height: 18),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                InfoChip(
                  icon: Icons.calendar_today_outlined,
                  label: formatDate(event.startAt),
                ),
                InfoChip(icon: Icons.schedule_outlined, label: event.timezone),
                if (event.venue.isNotEmpty)
                  InfoChip(icon: Icons.place_outlined, label: event.venue),
              ],
            ),
            const SizedBox(height: 22),
            Text(
              event.description,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: canUpload
                  ? () => context.push(
                      '/uploads?event=${Uri.encodeComponent(event.id)}',
                    )
                  : null,
              icon: const Icon(Icons.add_a_photo_outlined),
              label: Text(
                canUpload ? 'Contribute photos' : _uploadWindowMessage(event),
              ),
            ),
            if (event.gallery.isNotEmpty) ...[
              const SizedBox(height: 28),
              SectionTitle(title: 'Published gallery'),
              const SizedBox(height: 12),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: event.gallery.length,
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 2,
                  crossAxisSpacing: 10,
                  mainAxisSpacing: 10,
                  childAspectRatio: 1,
                ),
                itemBuilder: (context, index) {
                  final image = event.gallery[index];
                  return Semantics(
                    label: image.altText,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: image.url == null
                          ? ColoredBox(
                              color: Theme.of(
                                context,
                              ).colorScheme.surfaceContainerHighest,
                            )
                          : CachedNetworkImage(
                              imageUrl: context.api.absoluteUrl(image.url!),
                              fit: BoxFit.cover,
                              placeholder: (_, __) =>
                                  const ColoredBox(color: Color(0xffe0dbce)),
                            ),
                    ),
                  );
                },
              ),
            ],
          ],
        ),
      );
    },
  );

  String _uploadWindowMessage(EventRecord event) {
    if (event.uploadOpensAt != null &&
        DateTime.now().isBefore(event.uploadOpensAt!))
      return 'Uploads open ${formatDate(event.uploadOpensAt!)}';
    return 'Upload window closed';
  }
}

class UploadQueueItem {
  UploadQueueItem({
    required this.taskId,
    required this.fileName,
    required this.eventTitle,
    required this.clientSubmissionId,
    this.status = 'Queued',
    this.progress = 0,
  });

  final String taskId;
  final String fileName;
  final String eventTitle;
  final String clientSubmissionId;
  String status;
  double progress;
}

class UploadQueueScreen extends StatefulWidget {
  const UploadQueueScreen({super.key, this.eventId});

  final String? eventId;

  @override
  State<UploadQueueScreen> createState() => _UploadQueueScreenState();
}

class _UploadQueueScreenState extends State<UploadQueueScreen> {
  final picker = ImagePicker();
  final queue = <String, UploadQueueItem>{};
  final tasks = <String, UploadTask>{};
  final selected = <XFile>[];
  final progress = <String, double>{};
  late final StreamSubscription<TaskUpdate> updates;
  List<EventRecord> events = [];
  String? eventId;
  bool consent = false;
  bool credit = false;
  bool busy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    eventId = widget.eventId;
    updates = uploadQueueUpdates.stream.listen(_onTaskUpdate);
    _load();
    _recoverPicker();
    _restoreActiveTasks();
  }

  @override
  void dispose() {
    updates.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final result = await context.api.events();
      if (!mounted) return;
      setState(() {
        events = result
            .where((event) => uploadWindowIsOpen(event, DateTime.now()))
            .toList();
        if (eventId == null || !events.any((event) => event.id == eventId))
          eventId = events.isEmpty ? null : events.first.id;
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    }
  }

  Future<void> _restoreActiveTasks() async {
    try {
      final tasks = await FileDownloader().allTasks(allGroups: true);
      if (!mounted) return;
      setState(() {
        for (final task in tasks.whereType<UploadTask>()) {
          this.tasks[task.taskId] = task;
          final metadata = _metadata(task);
          queue[task.taskId] = UploadQueueItem(
            taskId: task.taskId,
            fileName: metadata['fileName'] as String? ?? task.filename,
            eventTitle: metadata['eventTitle'] as String? ?? 'Queued upload',
            clientSubmissionId:
                metadata['clientSubmissionId'] as String? ?? task.taskId,
            status: 'Restored; waiting to upload',
          );
        }
      });
    } catch (_) {
      // The native queue remains authoritative if its database cannot be read.
    }
  }

  Future<void> _recoverPicker() async {
    final lost = await picker.retrieveLostData();
    if (!lost.isEmpty && lost.files != null && mounted) {
      final remaining = (30 - selected.length).clamp(0, 30).toInt();
      setState(() => selected.addAll(lost.files!.take(remaining).toList()));
    }
    if (lost.exception != null && mounted)
      setState(
        () => error =
            'The photo picker was interrupted. Choose the photographs again.',
      );
  }

  void _onTaskUpdate(TaskUpdate update) {
    if (!mounted) return;
    final task = update.task;
    if (task is UploadTask) tasks[task.taskId] = task;
    final item = queue[task.taskId] ?? _itemFromTask(task);
    if (update is TaskProgressUpdate) {
      item.progress = update.progress.clamp(0, 1).toDouble();
      progress[task.taskId] = item.progress;
    } else if (update is TaskStatusUpdate) {
      item.status = _statusLabel(update.status);
      final serverStatus = _serverStatus(update.responseBody);
      if (serverStatus != null) item.status = serverStatus;
      if (update.status == TaskStatus.complete &&
          serverStatus == 'Submitted; pending review' &&
          task is UploadTask)
        unawaited(_removeCompletedFile(task));
    }
    queue[task.taskId] = item;
    setState(() {});
  }

  UploadQueueItem _itemFromTask(Task task) {
    final metadata = _metadata(task);
    return UploadQueueItem(
      taskId: task.taskId,
      fileName: metadata['fileName'] as String? ?? task.filename,
      eventTitle: metadata['eventTitle'] as String? ?? 'Queued upload',
      clientSubmissionId:
          metadata['clientSubmissionId'] as String? ?? task.taskId,
    );
  }

  Map<String, dynamic> _metadata(Task task) {
    try {
      final value = jsonDecode(task.metaData);
      return value is Map ? value.cast<String, dynamic>() : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  String? _serverStatus(String? responseBody) {
    if (responseBody == null || responseBody.isEmpty) return null;
    try {
      final body = jsonDecode(responseBody);
      final item = body is Map
          ? (body['items'] as List<dynamic>?)?.first
          : null;
      if (item is! Map) return null;
      final status = item['status'] as String?;
      if (status == 'pending_review') return 'Submitted; pending review';
      if (status == 'duplicate') return 'Duplicate rejected';
      if (status == 'failed')
        return 'Rejected: ${item['message'] ?? 'image could not be processed'}';
      return status;
    } catch (_) {
      return null;
    }
  }

  String _statusLabel(TaskStatus status) => switch (status) {
    TaskStatus.enqueued => 'Queued',
    TaskStatus.running => 'Uploading',
    TaskStatus.complete => 'Uploaded; pending server result',
    TaskStatus.failed => 'Upload failed; retry available',
    TaskStatus.waitingToRetry => 'Waiting to retry',
    TaskStatus.canceled => 'Canceled',
    _ => status.name,
  };

  Future<void> _removeCompletedFile(UploadTask task) async {
    try {
      final path = await task.filePath();
      await File(path).delete();
    } catch (_) {
      // Queue cleanup is best effort; the submission is already server-side.
    }
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Uploads',
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (error != null)
          Card(
            color: Theme.of(context).colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(error!),
            ),
          ),
        DropdownButtonFormField<String>(
          value: eventId,
          decoration: const InputDecoration(labelText: 'Event'),
          items: events
              .map(
                (event) => DropdownMenuItem(
                  value: event.id,
                  child: Text(event.title, overflow: TextOverflow.ellipsis),
                ),
              )
              .toList(),
          onChanged: busy ? null : (value) => setState(() => eventId = value),
        ),
        const SizedBox(height: 18),
        OutlinedButton.icon(
          onPressed: busy || selected.length >= 30 ? null : _pick,
          icon: const Icon(Icons.photo_library_outlined),
          label: Text(
            selected.isEmpty
                ? 'Choose photographs'
                : '${selected.length} selected',
          ),
        ),
        const SizedBox(height: 12),
        if (selected.isNotEmpty)
          SizedBox(
            height: 115,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: selected.length,
              separatorBuilder: (_, __) => const SizedBox(width: 10),
              itemBuilder: (_, index) => Stack(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.file(
                      File(selected[index].path),
                      width: 115,
                      height: 115,
                      fit: BoxFit.cover,
                    ),
                  ),
                  Positioned(
                    right: 4,
                    top: 4,
                    child: IconButton.filled(
                      tooltip: 'Remove photo',
                      onPressed: () => setState(() => selected.removeAt(index)),
                      icon: const Icon(Icons.close, size: 16),
                      padding: EdgeInsets.zero,
                    ),
                  ),
                ],
              ),
            ),
          ),
        CheckboxListTile(
          value: consent,
          onChanged: busy
              ? null
              : (value) => setState(() => consent = value ?? false),
          contentPadding: EdgeInsets.zero,
          title: const Text('I have permission to submit these photographs.'),
          subtitle: const Text(
            'The unit reviews each image before it becomes public.',
          ),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        CheckboxListTile(
          value: credit,
          onChanged: busy
              ? null
              : (value) => setState(() => credit = value ?? false),
          contentPadding: EdgeInsets.zero,
          title: const Text('Request contributor credit'),
          subtitle: const Text(
            'Credit is optional and never reveals your institutional email.',
          ),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        const SizedBox(height: 8),
        FilledButton.icon(
          onPressed: busy ? null : _enqueue,
          icon: const Icon(Icons.cloud_upload_outlined),
          label: Text(busy ? 'Adding to queue…' : 'Add to upload queue'),
        ),
        TextButton.icon(
          onPressed: () => context.go('/contributions'),
          icon: const Icon(Icons.history),
          label: const Text('View my contributions'),
        ),
        if (queue.isNotEmpty) ...[
          const SizedBox(height: 28),
          SectionTitle(title: 'Upload queue'),
          const SizedBox(height: 10),
          ...queue.values.map(
            (item) => UploadQueueTile(
              item: item,
              progress: progress[item.taskId] ?? item.progress,
              onRetry:
                  item.status.contains('retry') ||
                      item.status.startsWith('Rejected')
                  ? () => _retry(item)
                  : null,
            ),
          ),
        ],
      ],
    ),
  );

  Future<void> _pick() async {
    final files = await picker.pickMultiImage();
    if (!mounted || files.isEmpty) return;
    final remaining = (30 - selected.length).clamp(0, 30).toInt();
    setState(() {
      selected.addAll(files.take(remaining));
      if (files.length > remaining)
        error = 'The API accepts at most 30 photographs per batch.';
    });
  }

  Future<void> _enqueue() async {
    EventRecord? chosenEvent;
    for (final event in events) {
      if (event.id == eventId) {
        chosenEvent = event;
        break;
      }
    }
    if (chosenEvent == null) {
      setState(() => error = 'Choose an event whose upload window is open.');
      return;
    }
    final selectedEvent = chosenEvent;
    if (selected.isEmpty) {
      setState(() => error = 'Choose at least one photograph.');
      return;
    }
    if (!consent) {
      setState(
        () => error =
            'Confirm that you have permission to submit these photographs.',
      );
      return;
    }
    final accessToken = await context.api.store.accessToken;
    if (accessToken == null) {
      setState(
        () => error =
            'Your mobile session expired. Sign in again before uploading.',
      );
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final now = DateTime.now().microsecondsSinceEpoch;
      final queueDirectory = Directory(
        '${(await getApplicationSupportDirectory()).path}/nss-upload-queue',
      );
      await queueDirectory.create(recursive: true);
      final tasks = <UploadTask>[];
      for (var index = 0; index < selected.length; index++) {
        final file = selected[index];
        final clientSubmissionId = '$now-$index';
        final storedName =
            '$clientSubmissionId-${file.name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}';
        final storedFile = await File(
          file.path,
        ).copy('${queueDirectory.path}/$storedName');
        final task = UploadTask.fromFile(
          file: storedFile,
          taskId: 'nss-$clientSubmissionId',
          group: uploadQueueGroup,
          url: context.api.endpointUrl(
            '/events/${Uri.encodeComponent(selectedEvent.id)}/photos',
          ),
          headers: {
            'Authorization': 'Bearer $accessToken',
            'Accept': 'application/json',
          },
          fileField: 'photos',
          fields: {
            'consent': 'true',
            'creditRequested': '$credit',
            'clientSubmissionIds': jsonEncode([clientSubmissionId]),
          },
          retries: 2,
          updates: Updates.statusAndProgress,
          metaData: jsonEncode({
            'fileName': file.name,
            'eventTitle': selectedEvent.title,
            'eventId': selectedEvent.id,
            'clientSubmissionId': clientSubmissionId,
          }),
          displayName: file.name,
        );
        tasks.add(task);
        this.tasks[task.taskId] = task;
        queue[task.taskId] = UploadQueueItem(
          taskId: task.taskId,
          fileName: file.name,
          eventTitle: selectedEvent.title,
          clientSubmissionId: clientSubmissionId,
        );
      }
      final enqueued = await FileDownloader().enqueueAll(tasks);
      for (var index = 0; index < enqueued.length; index++) {
        if (!enqueued[index])
          queue[tasks[index].taskId]?.status = 'Could not enqueue; try again';
      }
      if (mounted) setState(() => selected.clear());
    } catch (_) {
      if (mounted)
        setState(
          () => error =
              'The upload queue could not be started. Check your connection and try again.',
        );
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _retry(UploadQueueItem item) async {
    final original = tasks[item.taskId];
    if (original == null) {
      setState(
        () => error =
            'The original upload file is no longer available. Select it again to retry.',
      );
      return;
    }
    final existingAccessToken = await context.api.store.accessToken;
    final hadRefreshToken = await context.api.store.refreshToken != null;
    final refreshed = await context.api.refresh();
    final accessToken = await context.api.store.accessToken;
    if (accessToken == null ||
        (hadRefreshToken && !refreshed && existingAccessToken == null)) {
      if (mounted)
        setState(
          () => error =
              'Your mobile session expired. Sign in again before retrying.',
        );
      return;
    }
    final retryTask = original.copyWith(
      taskId:
          '${original.taskId}-retry-${DateTime.now().microsecondsSinceEpoch}',
      headers: {
        'Authorization': 'Bearer $accessToken',
        'Accept': 'application/json',
      },
    );
    final retryItem = UploadQueueItem(
      taskId: retryTask.taskId,
      fileName: item.fileName,
      eventTitle: item.eventTitle,
      clientSubmissionId: item.clientSubmissionId,
    );
    setState(() {
      queue.remove(item.taskId);
      queue[retryTask.taskId] = retryItem;
      tasks[retryTask.taskId] = retryTask;
      error = null;
    });
    try {
      final enqueued = await FileDownloader().enqueue(retryTask);
      if (!enqueued && mounted)
        setState(
          () => retryItem.status = 'Could not enqueue; select again to retry',
        );
    } catch (_) {
      if (mounted)
        setState(
          () => retryItem.status = 'Could not enqueue; select again to retry',
        );
    }
  }
}

class UploadQueueTile extends StatelessWidget {
  const UploadQueueTile({
    super.key,
    required this.item,
    required this.progress,
    this.onRetry,
  });

  final UploadQueueItem item;
  final double progress;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 10),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: StatusDot(status: item.status),
            title: Text(item.fileName),
            subtitle: Text(item.eventTitle),
            trailing: onRetry == null
                ? Text(item.status, textAlign: TextAlign.end)
                : TextButton(onPressed: onRetry, child: const Text('Retry')),
          ),
          if (progress > 0 && progress < 1)
            LinearProgressIndicator(value: progress),
        ],
      ),
    ),
  );
}

class ContributionsScreen extends StatefulWidget {
  const ContributionsScreen({super.key});

  @override
  State<ContributionsScreen> createState() => _ContributionsScreenState();
}

class _ContributionsScreenState extends State<ContributionsScreen> {
  late Future<List<Contribution>> future;

  @override
  void initState() {
    super.initState();
    future = context.api.contributions();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'My contributions',
    child: FutureBuilder<List<Contribution>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = context.api.contributions()),
          );
        if (!snapshot.hasData) return const LoadingState();
        if (snapshot.data!.isEmpty)
          return const EmptyState(
            title: 'Your trail starts here',
            message:
                'Submit a photograph from a published event to see its review status.',
          );
        return ListView.separated(
          padding: const EdgeInsets.all(20),
          itemCount: snapshot.data!.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, index) {
            final item = snapshot.data![index];
            return Card(
              child: ListTile(
                leading: StatusDot(status: item.status),
                title: Text(item.fileName),
                subtitle: Text(
                  '${item.eventTitle} · ${formatDate(item.submittedAt)}',
                ),
                trailing: Text(item.status.toLowerCase().replaceAll('_', ' ')),
              ),
            );
          },
        );
      },
    ),
  );
}

class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> {
  late Future<List<NotificationItem>> future;

  @override
  void initState() {
    super.initState();
    future = context.api.notifications();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Inbox',
    child: FutureBuilder<List<NotificationItem>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = context.api.notifications()),
          );
        if (!snapshot.hasData) return const LoadingState();
        if (snapshot.data!.isEmpty)
          return const EmptyState(
            title: 'Inbox is clear',
            message: 'Review decisions and account updates will appear here.',
          );
        return ListView.separated(
          padding: const EdgeInsets.all(20),
          itemCount: snapshot.data!.length,
          separatorBuilder: (_, __) => const Divider(),
          itemBuilder: (_, index) {
            final item = snapshot.data![index];
            return ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                item.readAt == null
                    ? Icons.mark_email_unread_outlined
                    : Icons.mark_email_read_outlined,
              ),
              title: Text(item.title),
              subtitle: Text(item.body),
              isThreeLine: true,
              onTap: item.readAt != null
                  ? null
                  : () async {
                      await context.api.markNotificationRead(item.id);
                      if (mounted)
                        setState(() => future = context.api.notifications());
                    },
            );
          },
        );
      },
    ),
  );
}

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final user = context.app.state.user!;
    final name = user.displayName.trim();
    return PageFrame(
      title: 'Profile',
      child: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Card(
            child: ListTile(
              leading: CircleAvatar(
                child: Text(
                  name.isEmpty ? '?' : name.substring(0, 1).toUpperCase(),
                ),
              ),
              title: Text(user.displayName),
              subtitle: Text('${user.email}\n${roleLabel(user.role)}'),
            ),
          ),
          const SizedBox(height: 16),
          const Card(
            child: Column(
              children: [
                ListTile(
                  leading: Icon(Icons.privacy_tip_outlined),
                  title: Text('Privacy and consent'),
                  subtitle: Text(
                    'Your institutional email is never shown publicly. Credit is optional per upload.',
                  ),
                ),
                ListTile(
                  leading: Icon(Icons.help_outline),
                  title: Text('Upload guidelines'),
                  subtitle: Text(
                    'Use clear JPEG, PNG or WebP images and submit only photographs you have permission to share.',
                  ),
                ),
              ],
            ),
          ),
          if (user.role == UserRole.approver ||
              user.role == UserRole.admin) ...[
            const SizedBox(height: 18),
            AdminLink(
              title: 'Review queue',
              icon: Icons.photo_library_outlined,
              onTap: () => context.push('/review'),
            ),
          ],
          if (user.role == UserRole.admin) ...[
            const SizedBox(height: 8),
            AdminLink(
              title: 'Management',
              icon: Icons.admin_panel_settings_outlined,
              onTap: () => context.push('/admin'),
            ),
          ],
          const SizedBox(height: 18),
          OutlinedButton.icon(
            onPressed: () => context.app.logout(),
            icon: const Icon(Icons.logout),
            label: const Text('Sign out'),
          ),
        ],
      ),
    );
  }
}

class ReviewScreen extends StatefulWidget {
  const ReviewScreen({super.key});

  @override
  State<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends State<ReviewScreen> {
  late Future<List<ReviewItem>> future;

  @override
  void initState() {
    super.initState();
    future = context.api.reviewQueue();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Review queue',
    action: IconButton(
      onPressed: () => setState(() => future = context.api.reviewQueue()),
      icon: const Icon(Icons.refresh),
      tooltip: 'Refresh queue',
    ),
    child: FutureBuilder<List<ReviewItem>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = context.api.reviewQueue()),
          );
        if (!snapshot.hasData) return const LoadingState();
        if (snapshot.data!.isEmpty)
          return const EmptyState(
            title: 'Queue clear',
            message: 'New submissions will appear here.',
          );
        return ListView.separated(
          padding: const EdgeInsets.all(20),
          itemCount: snapshot.data!.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, index) {
            final item = snapshot.data![index];
            return Card(
              child: ListTile(
                leading: item.duplicateWarning == null && item.warnings == null
                    ? const Icon(Icons.photo_outlined)
                    : const Icon(Icons.warning_amber_outlined),
                title: Text(item.fileName),
                subtitle: Text('${item.eventTitle} · ${item.contributorName}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push('/review/${item.id}', extra: item),
              ),
            );
          },
        );
      },
    ),
  );
}

class ReviewDetailScreen extends StatefulWidget {
  const ReviewDetailScreen({super.key, required this.id, this.item});

  final String id;
  final ReviewItem? item;

  @override
  State<ReviewDetailScreen> createState() => _ReviewDetailScreenState();
}

class _ReviewDetailScreenState extends State<ReviewDetailScreen> {
  late Future<(ReviewItem, String?)> future;
  String? reason;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    future = _load();
  }

  Future<(ReviewItem, String?)> _load() async {
    final item =
        widget.item ??
        (await context.api.reviewQueue()).firstWhere(
          (candidate) => candidate.id == widget.id,
        );
    return (item, await context.api.store.accessToken);
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Review photograph',
    child: FutureBuilder<(ReviewItem, String?)>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = _load()),
          );
        if (!snapshot.hasData) return const LoadingState();
        final item = snapshot.data!.$1;
        final token = snapshot.data!.$2;
        final warnings = <String>[
          if (item.duplicateWarning != null) item.duplicateWarning!,
          ...warningLabels(item.warnings),
        ];
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (item.previewUrl.isNotEmpty)
              ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: CachedNetworkImage(
                  imageUrl: context.api.absoluteUrl(item.previewUrl),
                  httpHeaders: token == null
                      ? const {}
                      : {'Authorization': 'Bearer $token'},
                  fit: BoxFit.contain,
                  placeholder: (_, __) =>
                      const SizedBox(height: 260, child: LoadingState()),
                  errorWidget: (_, __, ___) => const SizedBox(
                    height: 160,
                    child: Center(
                      child: Text(
                        'Private preview unavailable. Refresh and try again.',
                      ),
                    ),
                  ),
                ),
              ),
            const SizedBox(height: 18),
            Text(item.fileName, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            Text('${item.eventTitle} · submitted by ${item.contributorName}'),
            if (item.width != null && item.height != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('${item.width} × ${item.height} pixels'),
              ),
            if (warnings.isNotEmpty) ...[
              const SizedBox(height: 18),
              Card(
                color: Theme.of(context).colorScheme.tertiaryContainer,
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Review warnings',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 6),
                      ...warnings.map(
                        (warning) => Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text('• $warning'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            const SizedBox(height: 18),
            TextField(
              onChanged: (value) => reason = value,
              decoration: const InputDecoration(
                labelText: 'Rejection reason (required to reject)',
                alignLabelWithHint: true,
              ),
              maxLines: 3,
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: busy ? null : () => _decide('reject'),
                    child: const Text('Reject'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: busy ? null : () => _decide('approve'),
                    child: const Text('Approve'),
                  ),
                ),
              ],
            ),
          ],
        );
      },
    ),
  );

  Future<void> _decide(String action) async {
    if (action == 'reject' && (reason == null || reason!.trim().isEmpty)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('A rejection reason is required.')),
      );
      return;
    }
    setState(() => busy = true);
    try {
      await context.api.decide(widget.id, action, reason: reason?.trim());
      if (mounted) context.pop();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

enum AdminListKind { media, users, homepage, audit }

class AdminHomeScreen extends StatelessWidget {
  const AdminHomeScreen({super.key});

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Management',
    child: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Text('Admin desk', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: 8),
        const Text(
          'Manage the same published records used by the web studio and public site.',
        ),
        const SizedBox(height: 22),
        AdminLink(
          title: 'Events & calendar',
          icon: Icons.event_note_outlined,
          onTap: () => context.push('/admin/events'),
        ),
        AdminLink(
          title: 'Academic archives',
          icon: Icons.history_edu_outlined,
          onTap: () => context.push('/admin/archives'),
        ),
        AdminLink(
          title: 'Media library',
          icon: Icons.perm_media_outlined,
          onTap: () => context.push('/admin/media'),
        ),
        AdminLink(
          title: 'Homepage revisions',
          icon: Icons.web_outlined,
          onTap: () => context.push('/admin/homepage'),
        ),
        AdminLink(
          title: 'Users & roles',
          icon: Icons.manage_accounts_outlined,
          onTap: () => context.push('/admin/users'),
        ),
        AdminLink(
          title: 'Audit trail',
          icon: Icons.fact_check_outlined,
          onTap: () => context.push('/admin/audit'),
        ),
      ],
    ),
  );
}

class AdminEventsScreen extends StatefulWidget {
  const AdminEventsScreen({super.key});

  @override
  State<AdminEventsScreen> createState() => _AdminEventsScreenState();
}

class _AdminEventsScreenState extends State<AdminEventsScreen> {
  late Future<List<Map<String, dynamic>>> future;

  @override
  void initState() {
    super.initState();
    future = context.api.adminEvents();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Admin events',
    action: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: () =>
              context.push('/admin/events/new').then((_) => _refresh()),
          icon: const Icon(Icons.add),
          tooltip: 'Create event',
        ),
        IconButton(
          onPressed: _refresh,
          icon: const Icon(Icons.refresh),
          tooltip: 'Refresh events',
        ),
      ],
    ),
    child: FutureBuilder<List<Map<String, dynamic>>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = context.api.adminEvents()),
          );
        if (!snapshot.hasData) return const LoadingState();
        if (snapshot.data!.isEmpty)
          return EmptyState(
            title: 'No events',
            message: 'Create the first event from this device.',
            action: FilledButton.icon(
              onPressed: () =>
                  context.push('/admin/events/new').then((_) => _refresh()),
              icon: const Icon(Icons.add),
              label: const Text('Create event'),
            ),
          );
        return ListView.separated(
          padding: const EdgeInsets.all(20),
          itemCount: snapshot.data!.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, index) {
            final event = snapshot.data![index];
            return Card(
              child: ListTile(
                onTap: () => context
                    .push('/admin/events/${event['id']}/edit', extra: event)
                    .then((_) => _refresh()),
                title: Text(event['title'] as String? ?? ''),
                subtitle: Text('${event['status']} · ${event['category']}'),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      onPressed: () => context
                          .push(
                            '/admin/events/${event['id']}/edit',
                            extra: event,
                          )
                          .then((_) => _refresh()),
                      icon: const Icon(Icons.edit_outlined),
                      tooltip: 'Edit event',
                    ),
                    if (event['status'] == 'DRAFT')
                      TextButton(
                        onPressed: () => _publish(event['id'] as String),
                        child: const Text('Publish'),
                      ),
                  ],
                ),
              ),
            );
          },
        );
      },
    ),
  );

  Future<void> _publish(String id) async {
    try {
      await context.api.publishEvent(id);
      if (mounted) setState(() => future = context.api.adminEvents());
    } catch (error) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
    }
  }

  void _refresh([Object? _]) {
    if (mounted) setState(() => future = context.api.adminEvents());
  }
}

class AdminEventFormScreen extends StatefulWidget {
  const AdminEventFormScreen({super.key, this.eventId, this.initialEvent});

  final String? eventId;
  final Map<String, dynamic>? initialEvent;

  @override
  State<AdminEventFormScreen> createState() => _AdminEventFormScreenState();
}

class _AdminEventFormScreenState extends State<AdminEventFormScreen> {
  final formKey = GlobalKey<FormState>();
  final title = TextEditingController();
  final slug = TextEditingController();
  final summary = TextEditingController();
  final description = TextEditingController();
  final category = TextEditingController();
  final timezone = TextEditingController(text: 'Asia/Kolkata');
  final venue = TextEditingController();
  final organizer = TextEditingController(text: 'NSS IIIT Naya Raipur');
  final collaborators = TextEditingController();
  final coordinators = TextEditingController();
  final mapUrl = TextEditingController();
  final registrationUrl = TextEditingController();
  final reportUrl = TextEditingController();
  final tags = TextEditingController();
  final socialUrls = TextEditingController();
  final displayOrder = TextEditingController(text: '0');
  final seoTitle = TextEditingController();
  final seoDescription = TextEditingController();
  DateTime? startAt;
  DateTime? endAt;
  DateTime? uploadOpensAt;
  DateTime? uploadClosesAt;
  String status = 'DRAFT';
  String visibility = 'PRIVATE';
  String? academicYearId;
  bool featured = false;
  bool loading = false;
  bool saving = false;
  bool workflowBusy = false;
  String? error;
  List<Map<String, dynamic>> academicYears = [];

  @override
  void initState() {
    super.initState();
    _applyEvent(widget.initialEvent);
    _load();
  }

  @override
  void dispose() {
    for (final controller in [
      title,
      slug,
      summary,
      description,
      category,
      timezone,
      venue,
      organizer,
      collaborators,
      coordinators,
      mapUrl,
      registrationUrl,
      reportUrl,
      tags,
      socialUrls,
      displayOrder,
      seoTitle,
      seoDescription,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => loading = true);
    try {
      final years = await context.api.archives();
      Map<String, dynamic>? event = widget.initialEvent;
      if (widget.eventId != null) {
        final events = await context.api.adminEvents();
        for (final candidate in events) {
          if (candidate['id'] == widget.eventId) {
            event = candidate;
            break;
          }
        }
      }
      if (!mounted) return;
      setState(() {
        academicYears = years;
        _applyEvent(event);
        loading = false;
        if (widget.eventId != null && event == null)
          error = 'This event could not be loaded.';
      });
    } catch (e) {
      if (mounted)
        setState(() {
          loading = false;
          error = e.toString();
        });
    }
  }

  void _applyEvent(Map<String, dynamic>? event) {
    if (event == null) return;
    title.text = '${event['title'] ?? ''}';
    slug.text = '${event['slug'] ?? ''}';
    summary.text = '${event['summary'] ?? ''}';
    description.text = '${event['description'] ?? ''}';
    category.text = '${event['category'] ?? ''}';
    timezone.text = '${event['timezone'] ?? 'Asia/Kolkata'}';
    venue.text = '${event['venue'] ?? ''}';
    organizer.text = '${event['organizer'] ?? 'NSS IIIT Naya Raipur'}';
    collaborators.text = '${event['collaboratingOrganizations'] ?? ''}';
    coordinators.text = '${event['coordinators'] ?? ''}';
    mapUrl.text = '${event['mapUrl'] ?? ''}';
    registrationUrl.text = '${event['registrationUrl'] ?? ''}';
    reportUrl.text = '${event['reportUrl'] ?? ''}';
    tags.text = _joinList(event['tags']);
    socialUrls.text = _joinList(event['socialUrls']);
    displayOrder.text = '${event['displayOrder'] ?? 0}';
    seoTitle.text = '${event['seoTitle'] ?? ''}';
    seoDescription.text = '${event['seoDescription'] ?? ''}';
    startAt = _date(event['startAt']);
    endAt = _date(event['endAt']);
    uploadOpensAt = _date(event['uploadOpensAt']);
    uploadClosesAt = _date(event['uploadClosesAt']);
    status = '${event['status'] ?? 'DRAFT'}';
    visibility =
        '${event['visibility'] ?? (status == 'DRAFT' ? 'PRIVATE' : 'PUBLIC')}';
    featured = event['featured'] == true;
    final academicYear = event['academicYear'];
    if (academicYear is Map && academicYear['id'] is String)
      academicYearId = academicYear['id'] as String;
  }

  DateTime? _date(Object? value) =>
      value == null ? null : DateTime.tryParse('$value')?.toLocal();
  String _joinList(Object? value) => value is List ? value.join(', ') : '';
  List<String> _splitList(String value) => value
      .split(',')
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .toList();
  List<String> get _statusOptions => [
    'DRAFT',
    if (status == 'SCHEDULED') 'SCHEDULED',
    'PUBLISHED',
    'ONGOING',
    'COMPLETED',
    'CANCELLED',
    'ARCHIVED',
  ];

  @override
  Widget build(BuildContext context) => PageFrame(
    title: widget.eventId == null ? 'Create event' : 'Edit event',
    action: loading
        ? null
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                onPressed: saving || workflowBusy ? null : _save,
                icon: const Icon(Icons.save_outlined),
                tooltip: 'Save event',
              ),
              if (widget.eventId != null)
                PopupMenuButton<String>(
                  enabled: !saving && !workflowBusy,
                  onSelected: _runWorkflow,
                  itemBuilder: (context) => [
                    if ({
                      'DRAFT',
                      'SCHEDULED',
                      'ONGOING',
                      'COMPLETED',
                    }.contains(status))
                      const PopupMenuItem(
                        value: 'publish',
                        child: Text('Publish event'),
                      ),
                    if (status != 'DRAFT' &&
                        status != 'CANCELLED' &&
                        status != 'ARCHIVED')
                      const PopupMenuItem(
                        value: 'unpublish',
                        child: Text('Unpublish event'),
                      ),
                    if (status != 'CANCELLED' && status != 'ARCHIVED')
                      const PopupMenuItem(
                        value: 'archive',
                        child: Text('Archive event'),
                      ),
                  ],
                  tooltip: 'Publishing controls',
                ),
            ],
          ),
    child: loading
        ? const LoadingState()
        : Form(
            key: formKey,
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                if (error != null)
                  Card(
                    color: Theme.of(context).colorScheme.errorContainer,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(error!),
                    ),
                  ),
                _field(title, 'Title', required: true),
                _field(
                  slug,
                  'Slug',
                  required: true,
                  helper: 'Lowercase letters, numbers, and hyphens only.',
                  validator: (value) {
                    if (value == null || value.trim().isEmpty)
                      return 'Slug is required.';
                    return RegExp(
                          r'^[a-z0-9]+(?:-[a-z0-9]+)*$',
                        ).hasMatch(value.trim())
                        ? null
                        : 'Use lowercase letters, numbers, and hyphens only.';
                  },
                ),
                _field(category, 'Category', required: true),
                _field(summary, 'Summary', maxLines: 2),
                _field(description, 'Description', required: true, maxLines: 6),
                _field(timezone, 'Timezone', required: true),
                _field(venue, 'Venue'),
                _field(organizer, 'Organizer'),
                _field(
                  collaborators,
                  'Collaborating organizations',
                  maxLines: 2,
                ),
                _field(coordinators, 'Coordinators', maxLines: 2),
                _dateField(
                  'Start',
                  startAt,
                  required: true,
                  onChanged: (value) => setState(() => startAt = value),
                ),
                _dateField(
                  'End',
                  endAt,
                  onChanged: (value) => setState(() => endAt = value),
                ),
                _dateField(
                  'Upload opens',
                  uploadOpensAt,
                  onChanged: (value) => setState(() => uploadOpensAt = value),
                ),
                _dateField(
                  'Upload closes',
                  uploadClosesAt,
                  onChanged: (value) => setState(() => uploadClosesAt = value),
                ),
                DropdownButtonFormField<String>(
                  value: status,
                  decoration: const InputDecoration(labelText: 'Status'),
                  items: _statusOptions
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: saving || workflowBusy
                      ? null
                      : (value) => setState(() => status = value ?? 'DRAFT'),
                ),
                const SizedBox(height: 14),
                DropdownButtonFormField<String>(
                  value: visibility,
                  decoration: const InputDecoration(labelText: 'Visibility'),
                  items: const ['PRIVATE', 'PUBLIC']
                      .map(
                        (value) =>
                            DropdownMenuItem(value: value, child: Text(value)),
                      )
                      .toList(),
                  onChanged: saving || workflowBusy
                      ? null
                      : (value) =>
                            setState(() => visibility = value ?? 'PRIVATE'),
                ),
                const SizedBox(height: 14),
                DropdownButtonFormField<String>(
                  value: academicYearId ?? '',
                  decoration: const InputDecoration(
                    labelText: 'Academic year (optional)',
                  ),
                  items: [
                    const DropdownMenuItem<String>(
                      value: '',
                      child: Text('No academic year'),
                    ),
                    ...academicYears
                        .where((year) => year['id'] is String)
                        .map(
                          (year) => DropdownMenuItem(
                            value: year['id'] as String,
                            child: Text(
                              '${year['label'] ?? year['slug'] ?? 'Academic year'}',
                            ),
                          ),
                        ),
                  ],
                  onChanged: saving || workflowBusy
                      ? null
                      : (value) => setState(
                          () => academicYearId = value == null || value.isEmpty
                              ? null
                              : value,
                        ),
                ),
                _field(tags, 'Tags', helper: 'Comma-separated'),
                _field(
                  socialUrls,
                  'Social URLs',
                  helper: 'Comma-separated full URLs',
                  validator: _socialUrlsValidator,
                ),
                _field(mapUrl, 'Map URL', validator: _urlValidator),
                _field(
                  registrationUrl,
                  'Registration URL',
                  validator: _urlValidator,
                ),
                _field(reportUrl, 'Report URL', validator: _urlValidator),
                _field(seoTitle, 'SEO title'),
                _field(seoDescription, 'SEO description', maxLines: 3),
                _field(
                  displayOrder,
                  'Display order',
                  keyboardType: TextInputType.number,
                  validator: _nonNegativeIntegerValidator,
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Featured event'),
                  value: featured,
                  onChanged: saving || workflowBusy
                      ? null
                      : (value) => setState(() => featured = value),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  onPressed: saving || workflowBusy ? null : _save,
                  icon: const Icon(Icons.save_outlined),
                  label: Text(saving ? 'Saving…' : 'Save event'),
                ),
                if (widget.eventId != null) ...[
                  const SizedBox(height: 24),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Publishing controls',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 6),
                          const Text(
                            'Use these actions to update the public lifecycle. They also update the event visibility on the server.',
                          ),
                          const SizedBox(height: 14),
                          Wrap(
                            spacing: 10,
                            runSpacing: 10,
                            children: [
                              if ({
                                'DRAFT',
                                'SCHEDULED',
                                'ONGOING',
                                'COMPLETED',
                              }.contains(status))
                                OutlinedButton.icon(
                                  onPressed: workflowBusy
                                      ? null
                                      : () => _runWorkflow('publish'),
                                  icon: const Icon(Icons.publish_outlined),
                                  label: const Text('Publish'),
                                ),
                              if (status != 'DRAFT' &&
                                  status != 'CANCELLED' &&
                                  status != 'ARCHIVED')
                                OutlinedButton.icon(
                                  onPressed: workflowBusy
                                      ? null
                                      : () => _runWorkflow('unpublish'),
                                  icon: const Icon(
                                    Icons.visibility_off_outlined,
                                  ),
                                  label: const Text('Unpublish'),
                                ),
                              if (status != 'CANCELLED' && status != 'ARCHIVED')
                                OutlinedButton.icon(
                                  onPressed: workflowBusy
                                      ? null
                                      : () => _runWorkflow('archive'),
                                  icon: const Icon(Icons.archive_outlined),
                                  label: const Text('Archive'),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
  );

  Widget _field(
    TextEditingController controller,
    String label, {
    bool required = false,
    String? helper,
    int maxLines = 1,
    TextInputType? keyboardType,
    String? Function(String?)? validator,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: TextFormField(
      controller: controller,
      keyboardType: keyboardType,
      maxLines: maxLines,
      decoration: InputDecoration(
        labelText: required ? '$label *' : label,
        helperText: helper,
      ),
      validator:
          validator ??
          (required
              ? (value) => value == null || value.trim().isEmpty
                    ? '$label is required.'
                    : null
              : null),
    ),
  );

  String? _urlValidator(String? value) {
    if (value == null || value.trim().isEmpty) return null;
    final uri = Uri.tryParse(value.trim());
    return uri != null &&
            (uri.scheme == 'http' || uri.scheme == 'https') &&
            uri.host.isNotEmpty
        ? null
        : 'Enter a full http or https URL.';
  }

  String? _socialUrlsValidator(String? value) {
    for (final url in _splitList(value ?? '')) {
      if (_urlValidator(url) != null)
        return 'Every social URL must be a full http or https URL.';
    }
    return null;
  }

  String? _nonNegativeIntegerValidator(String? value) {
    final number = int.tryParse(value?.trim() ?? '');
    return number == null || number < 0 ? 'Enter a non-negative number.' : null;
  }

  Widget _dateField(
    String label,
    DateTime? value, {
    required ValueChanged<DateTime?> onChanged,
    bool required = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: TextFormField(
      key: ValueKey('$label-${value?.millisecondsSinceEpoch ?? 0}'),
      readOnly: true,
      initialValue: value == null ? '' : formatDateTime(value),
      decoration: InputDecoration(
        labelText: required ? '$label *' : label,
        suffixIcon: value == null
            ? const Icon(Icons.calendar_today_outlined)
            : IconButton(
                onPressed: () => onChanged(null),
                icon: const Icon(Icons.clear),
                tooltip: 'Clear',
              ),
      ),
      validator: required && value == null
          ? (_) => '$label is required.'
          : null,
      onTap: () async {
        final picked = await _pickDateTime(value);
        if (picked != null) onChanged(picked);
      },
    ),
  );

  Future<DateTime?> _pickDateTime(DateTime? current) async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: current ?? now,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (date == null || !mounted) return null;
    final time = await showTimePicker(
      context: context,
      initialTime: current == null
          ? TimeOfDay.fromDateTime(now)
          : TimeOfDay.fromDateTime(current),
    );
    if (time == null) return null;
    return DateTime(date.year, date.month, date.day, time.hour, time.minute);
  }

  Future<void> _save() async {
    if (saving || workflowBusy) return;
    setState(() => error = null);
    if (!formKey.currentState!.validate()) return;
    if (startAt == null ||
        (endAt != null && !endAt!.isAfter(startAt!)) ||
        (uploadOpensAt != null &&
            uploadClosesAt != null &&
            !uploadClosesAt!.isAfter(uploadOpensAt!))) {
      setState(() => error = 'Check the event and upload date ranges.');
      return;
    }
    setState(() {
      saving = true;
      error = null;
    });
    final payload = <String, dynamic>{
      'title': title.text.trim(),
      'slug': slug.text.trim(),
      'summary': summary.text.trim(),
      'description': description.text.trim(),
      'category': category.text.trim(),
      'tags': _splitList(tags.text),
      'startAt': startAt!.toUtc().toIso8601String(),
      'endAt': endAt?.toUtc().toIso8601String(),
      'timezone': timezone.text.trim(),
      'venue': venue.text.trim(),
      'organizer': organizer.text.trim(),
      'collaboratingOrganizations': collaborators.text.trim(),
      'coordinators': coordinators.text.trim(),
      'mapUrl': _nullable(mapUrl.text),
      'registrationUrl': _nullable(registrationUrl.text),
      'reportUrl': _nullable(reportUrl.text),
      'status': status == 'PUBLISHED' ? 'DRAFT' : status,
      'visibility': visibility,
      'featured': featured,
      'displayOrder': int.tryParse(displayOrder.text) ?? 0,
      'uploadOpensAt': uploadOpensAt?.toUtc().toIso8601String(),
      'uploadClosesAt': uploadClosesAt?.toUtc().toIso8601String(),
    };
    if (widget.eventId == null || socialUrls.text.trim().isNotEmpty)
      payload['socialUrls'] = _splitList(socialUrls.text);
    if (widget.eventId == null || academicYearId != null)
      payload['academicYearId'] = academicYearId;
    if (widget.eventId == null || seoTitle.text.trim().isNotEmpty)
      payload['seoTitle'] = _nullable(seoTitle.text);
    if (widget.eventId == null || seoDescription.text.trim().isNotEmpty)
      payload['seoDescription'] = _nullable(seoDescription.text);
    try {
      if (widget.eventId == null) {
        final result = await context.api.createEvent(payload);
        if (status == 'PUBLISHED') {
          final created = result['event'];
          if (created is! Map || created['id'] is! String)
            throw const ApiException(
              'The event was created, but its id was not returned for publishing.',
            );
          await context.api.publishEvent(created['id'] as String);
        }
      } else {
        await context.api.updateEvent(widget.eventId!, payload);
        if (status == 'PUBLISHED')
          await context.api.publishEvent(widget.eventId!);
      }
      if (mounted) context.pop(true);
    } catch (e) {
      if (mounted)
        setState(() {
          saving = false;
          error = e.toString();
        });
    }
  }

  String? _nullable(String value) => value.trim().isEmpty ? null : value.trim();

  Future<void> _runWorkflow(String action) async {
    if (widget.eventId == null || workflowBusy || saving) return;
    setState(() {
      workflowBusy = true;
      error = null;
    });
    try {
      if (action == 'publish') {
        await context.api.publishEvent(widget.eventId!);
      } else if (action == 'unpublish') {
        await context.api.unpublishEvent(widget.eventId!);
      } else if (action == 'archive') {
        await context.api.archiveEvent(widget.eventId!);
      }
      await _load();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => workflowBusy = false);
    }
  }
}

class AdminArchivesScreen extends StatefulWidget {
  const AdminArchivesScreen({super.key});

  @override
  State<AdminArchivesScreen> createState() => _AdminArchivesScreenState();
}

class _AdminArchivesScreenState extends State<AdminArchivesScreen> {
  late Future<List<Map<String, dynamic>>> future;

  @override
  void initState() {
    super.initState();
    future = context.api.archives();
  }

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Academic archives',
    action: IconButton(
      onPressed: _refresh,
      icon: const Icon(Icons.refresh),
      tooltip: 'Refresh archives',
    ),
    child: FutureBuilder<List<Map<String, dynamic>>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: _refresh,
          );
        if (!snapshot.hasData) return const LoadingState();
        if (snapshot.data!.isEmpty)
          return const EmptyState(
            title: 'No academic years',
            message: 'Create an academic year from the management web app.',
          );
        return ListView.separated(
          padding: const EdgeInsets.all(20),
          itemCount: snapshot.data!.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (_, index) {
            final year = snapshot.data![index];
            final published = year['published'] == true;
            return Card(
              child: ListTile(
                onTap: () => context
                    .push('/admin/archives/${year['id']}')
                    .then((_) => _refresh()),
                title: Text(
                  '${year['label'] ?? year['slug'] ?? 'Academic year'}',
                ),
                subtitle: Text(
                  '${year['eventCount'] ?? 0} events · ${year['rosterCount'] ?? 0} roster members',
                ),
                trailing: published
                    ? const Text('Published')
                    : TextButton(
                        onPressed: () => _publish(year['id'] as String),
                        child: const Text('Publish'),
                      ),
              ),
            );
          },
        );
      },
    ),
  );

  Future<void> _publish(String id) async {
    try {
      await context.api.publishAcademicYear(id);
      _refresh();
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  void _refresh([Object? _]) {
    if (mounted) setState(() => future = context.api.archives());
  }
}

class AdminArchiveDetailScreen extends StatefulWidget {
  const AdminArchiveDetailScreen({super.key, required this.id});

  final String id;

  @override
  State<AdminArchiveDetailScreen> createState() =>
      _AdminArchiveDetailScreenState();
}

class _AdminArchiveDetailScreenState extends State<AdminArchiveDetailScreen> {
  late Future<(Map<String, dynamic>, List<Map<String, dynamic>>)> future;
  final designation = TextEditingController();
  final displayOrder = TextEditingController(text: '0');
  String? memberId;
  bool featured = false;
  bool assigning = false;
  bool publishing = false;

  @override
  void initState() {
    super.initState();
    future = _load();
  }

  @override
  void dispose() {
    designation.dispose();
    displayOrder.dispose();
    super.dispose();
  }

  Future<(Map<String, dynamic>, List<Map<String, dynamic>>)> _load() async => (
    await context.api.academicYear(widget.id),
    await context.api.adminTeam(),
  );

  @override
  Widget build(BuildContext context) => PageFrame(
    title: 'Archive detail',
    child: FutureBuilder<(Map<String, dynamic>, List<Map<String, dynamic>>)>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = _load()),
          );
        if (!snapshot.hasData) return const LoadingState();
        final year = snapshot.data!.$1;
        final team = snapshot.data!.$2;
        final roster = (year['rosters'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .toList();
        final events = (year['events'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .toList();
        final published = year['published'] == true;
        return ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              '${year['label'] ?? year['slug'] ?? 'Academic year'}',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 8),
            Text(
              '${events.length} events · ${roster.length} roster assignments · ${published ? 'Published' : 'Draft'}',
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: publishing
                        ? null
                        : () => _setPublished(!published),
                    child: Text(
                      publishing
                          ? 'Updating…'
                          : published
                          ? 'Unpublish archive'
                          : 'Publish archive',
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            SectionTitle(title: 'Roster assignments'),
            const SizedBox(height: 10),
            if (roster.isEmpty)
              const EmptyState(
                title: 'No assignments',
                message: 'Assign active team members to this academic year.',
              )
            else
              ...roster.map((entry) => _rosterTile(entry)),
            const SizedBox(height: 24),
            SectionTitle(title: 'Assign a team member'),
            const SizedBox(height: 10),
            if (team.isEmpty)
              const Text('No team members are available.')
            else ...[
              DropdownButtonFormField<String>(
                value: memberId,
                decoration: const InputDecoration(labelText: 'Team member'),
                items: team
                    .where((member) => member['id'] is String)
                    .map(
                      (member) => DropdownMenuItem<String>(
                        value: member['id'] as String,
                        child: Text(
                          '${member['fullName'] ?? member['displayName'] ?? 'Member'}',
                        ),
                      ),
                    )
                    .toList(),
                onChanged: assigning
                    ? null
                    : (value) => setState(() => memberId = value),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: designation,
                decoration: const InputDecoration(
                  labelText: 'Archive designation',
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: displayOrder,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Display order'),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Featured in this archive'),
                value: featured,
                onChanged: assigning
                    ? null
                    : (value) => setState(() => featured = value),
              ),
              FilledButton.icon(
                onPressed: assigning ? null : _assign,
                icon: const Icon(Icons.person_add_alt_1),
                label: Text(assigning ? 'Assigning…' : 'Assign member'),
              ),
            ],
          ],
        );
      },
    ),
  );

  Widget _rosterTile(Map<String, dynamic> entry) {
    final member = entry['member'] as Map<String, dynamic>?;
    final name = member?['fullName'] ?? member?['displayName'] ?? 'Member';
    return Card(
      child: ListTile(
        title: Text('$name'),
        subtitle: Text(
          '${entry['designation'] ?? ''}${entry['featured'] == true ? ' · Featured' : ''}',
        ),
        trailing: IconButton(
          onPressed: () => _remove(entry['id'] as String),
          icon: const Icon(Icons.delete_outline),
          tooltip: 'Remove assignment',
        ),
      ),
    );
  }

  Future<void> _setPublished(bool publish) async {
    setState(() => publishing = true);
    try {
      if (publish) {
        await context.api.publishAcademicYear(widget.id);
      } else {
        await context.api.unpublishAcademicYear(widget.id);
      }
      if (mounted) setState(() => future = _load());
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    } finally {
      if (mounted) setState(() => publishing = false);
    }
  }

  Future<void> _assign() async {
    if (memberId == null || designation.text.trim().length < 2) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Choose a member and enter a designation.'),
        ),
      );
      return;
    }
    setState(() => assigning = true);
    try {
      await context.api.assignRoster(
        widget.id,
        memberId: memberId!,
        designation: designation.text.trim(),
        displayOrder: int.tryParse(displayOrder.text) ?? 0,
        featured: featured,
      );
      designation.clear();
      memberId = null;
      featured = false;
      if (mounted)
        setState(() {
          assigning = false;
          future = _load();
        });
    } catch (e) {
      if (mounted)
        setState(() {
          assigning = false;
        });
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _remove(String membershipId) async {
    final confirmed =
        await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Remove assignment?'),
            content: const Text(
              'This only removes the member from this academic archive.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Remove'),
              ),
            ],
          ),
        ) ??
        false;
    if (!confirmed) return;
    try {
      await context.api.removeRoster(widget.id, membershipId);
      if (mounted) setState(() => future = _load());
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }
}

class AdminListScreen extends StatefulWidget {
  const AdminListScreen({super.key, required this.title, required this.kind});

  final String title;
  final AdminListKind kind;

  @override
  State<AdminListScreen> createState() => _AdminListScreenState();
}

class _AdminListScreenState extends State<AdminListScreen> {
  late Future<List<Map<String, dynamic>>> future;

  @override
  void initState() {
    super.initState();
    future = load();
  }

  Future<List<Map<String, dynamic>>> load() => switch (widget.kind) {
    AdminListKind.media => context.api.media(),
    AdminListKind.users => context.api.users(),
    AdminListKind.homepage => context.api.homepageRevisions(),
    AdminListKind.audit => context.api.audit(),
  };

  @override
  Widget build(BuildContext context) => PageFrame(
    title: widget.title,
    action: IconButton(
      onPressed: () => setState(() => future = load()),
      icon: const Icon(Icons.refresh),
      tooltip: 'Refresh',
    ),
    child: FutureBuilder<List<Map<String, dynamic>>>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return ErrorState(
            message: snapshot.error.toString(),
            retry: () => setState(() => future = load()),
          );
        if (!snapshot.hasData) return const LoadingState();
        if (snapshot.data!.isEmpty)
          return const EmptyState(
            title: 'Nothing here yet',
            message:
                'Records will appear after they are created in the management workflow.',
          );
        return ListView.separated(
          padding: const EdgeInsets.all(20),
          itemCount: snapshot.data!.length,
          separatorBuilder: (_, __) => const Divider(),
          itemBuilder: (_, index) {
            final item = snapshot.data![index];
            final title =
                item['title'] ??
                item['label'] ??
                item['displayName'] ??
                item['action'] ??
                item['originalName'] ??
                'Record';
            final subtitle =
                item['status'] ??
                item['slug'] ??
                item['email'] ??
                item['createdAt'] ??
                item['version'] ??
                '';
            return ListTile(title: Text('$title'), subtitle: Text('$subtitle'));
          },
        );
      },
    ),
  );
}

class EventTile extends StatelessWidget {
  const EventTile({super.key, required this.event});

  final EventRecord event;

  @override
  Widget build(BuildContext context) => Card(
    child: ListTile(
      contentPadding: const EdgeInsets.all(12),
      title: Text(
        event.title,
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
      subtitle: Text(
        '${formatDate(event.startAt)} · ${event.venue.isEmpty ? 'Venue to be announced' : event.venue}',
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push('/events/${event.slug}'),
    ),
  );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle({super.key, required this.title, this.action});

  final String title;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisAlignment: MainAxisAlignment.spaceBetween,
    children: [
      Text(title, style: Theme.of(context).textTheme.titleLarge),
      if (action != null) action!,
    ],
  );
}

class InfoChip extends StatelessWidget {
  const InfoChip({super.key, required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) =>
      Chip(avatar: Icon(icon, size: 16), label: Text(label));
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color =
        status == 'PUBLISHED' ||
            status == 'APPROVED' ||
            status.contains('Submitted')
        ? const Color(0xff347a58)
        : status == 'REJECTED' ||
              status.contains('failed') ||
              status.contains('Duplicate')
        ? const Color(0xffa23b35)
        : const Color(0xffa96d1b);
    return CircleAvatar(
      radius: 18,
      backgroundColor: color.withAlpha(30),
      child: Icon(Icons.circle, size: 10, color: color),
    );
  }
}

class AdminLink extends StatelessWidget {
  const AdminLink({
    super.key,
    required this.title,
    required this.icon,
    required this.onTap,
  });

  final String title;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 10),
    child: ListTile(
      leading: Icon(icon),
      title: Text(title),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    ),
  );
}

class LoadingState extends StatelessWidget {
  const LoadingState({super.key});

  @override
  Widget build(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(32),
      child: CircularProgressIndicator(),
    ),
  );
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    required this.message,
    this.action,
  });

  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.hourglass_empty_outlined, size: 40),
          const SizedBox(height: 12),
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(message, textAlign: TextAlign.center),
          if (action != null) ...[const SizedBox(height: 16), action!],
        ],
      ),
    ),
  );
}

class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, required this.retry});

  final String message;
  final VoidCallback retry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.cloud_off_outlined, size: 40),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: retry, child: const Text('Try again')),
        ],
      ),
    ),
  );
}

List<String> warningLabels(Object? value) =>
    value is List ? value.map((item) => '$item').toList() : const [];

String formatDate(DateTime value) =>
    '${value.day.toString().padLeft(2, '0')} ${const ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][value.month - 1]} ${value.year}';

String formatDateTime(DateTime value) =>
    '${formatDate(value)} · ${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';

String roleLabel(UserRole role) => switch (role) {
  UserRole.admin => 'Administrator',
  UserRole.approver => 'Photo approver',
  UserRole.user => 'Student contributor',
};

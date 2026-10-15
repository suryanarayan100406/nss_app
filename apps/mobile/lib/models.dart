enum UserRole { user, approver, admin }

UserRole roleFromJson(Object? value) => switch (value) {
  'ADMIN' => UserRole.admin,
  'APPROVER' => UserRole.approver,
  _ => UserRole.user,
};

class AppUser {
  const AppUser({
    required this.id,
    required this.email,
    required this.displayName,
    required this.role,
    required this.emailVerified,
  });

  final String id;
  final String email;
  final String displayName;
  final UserRole role;
  final bool emailVerified;

  factory AppUser.fromJson(Map<String, dynamic> json) => AppUser(
    id: json['id'] as String,
    email: json['email'] as String,
    displayName: json['displayName'] as String,
    role: roleFromJson(json['role']),
    emailVerified: json['emailVerified'] as bool? ?? false,
  );
}

class EventRecord {
  const EventRecord({
    required this.id,
    required this.slug,
    required this.title,
    required this.summary,
    required this.description,
    required this.category,
    required this.startAt,
    required this.endAt,
    required this.timezone,
    required this.venue,
    required this.status,
    this.uploadOpensAt,
    this.uploadClosesAt,
    this.coverUrl,
    this.coverAlt,
    this.gallery = const [],
  });

  final String id;
  final String slug;
  final String title;
  final String summary;
  final String description;
  final String category;
  final DateTime startAt;
  final DateTime? endAt;
  final String timezone;
  final String venue;
  final String status;
  final DateTime? uploadOpensAt;
  final DateTime? uploadClosesAt;
  final String? coverUrl;
  final String? coverAlt;
  final List<GalleryImage> gallery;

  factory EventRecord.fromJson(Map<String, dynamic> json) => EventRecord(
    id: json['id'] as String,
    slug: json['slug'] as String,
    title: json['title'] as String? ?? '',
    summary: json['summary'] as String? ?? '',
    description: json['description'] as String? ?? '',
    category: json['category'] as String? ?? '',
    startAt: DateTime.parse(json['startAt'] as String),
    endAt: json['endAt'] == null
        ? null
        : DateTime.parse(json['endAt'] as String),
    timezone: json['timezone'] as String? ?? 'Asia/Kolkata',
    venue: json['venue'] as String? ?? '',
    status: json['status'] as String? ?? '',
    uploadOpensAt: json['uploadOpensAt'] == null
        ? null
        : DateTime.parse(json['uploadOpensAt'] as String),
    uploadClosesAt: json['uploadClosesAt'] == null
        ? null
        : DateTime.parse(json['uploadClosesAt'] as String),
    coverUrl: (json['cover'] as Map<String, dynamic>?)?['url'] as String?,
    coverAlt: (json['cover'] as Map<String, dynamic>?)?['altText'] as String?,
    gallery: ((json['gallery'] as List<dynamic>?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(GalleryImage.fromJson)
        .toList(),
  );
}

class GalleryImage {
  const GalleryImage({
    required this.url,
    required this.altText,
    required this.caption,
    required this.credit,
  });
  final String? url;
  final String altText;
  final String caption;
  final String credit;

  factory GalleryImage.fromJson(Map<String, dynamic> json) => GalleryImage(
    url: json['url'] as String?,
    altText: json['altText'] as String? ?? '',
    caption: json['caption'] as String? ?? '',
    credit: json['credit'] as String? ?? '',
  );
}

class Contribution {
  const Contribution({
    required this.id,
    required this.eventTitle,
    required this.fileName,
    required this.status,
    required this.submittedAt,
    this.rejectionReason,
    this.warnings,
  });
  final String id;
  final String eventTitle;
  final String fileName;
  final String status;
  final DateTime submittedAt;
  final String? rejectionReason;
  final Object? warnings;

  factory Contribution.fromJson(Map<String, dynamic> json) => Contribution(
    id: json['id'] as String,
    eventTitle:
        (json['event'] as Map<String, dynamic>?)?['title'] as String? ?? '',
    fileName: json['fileName'] as String? ?? '',
    status: json['status'] as String? ?? '',
    submittedAt: DateTime.parse(json['submittedAt'] as String),
    rejectionReason: json['rejectionReason'] as String?,
    warnings: json['warnings'],
  );
}

class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.title,
    required this.body,
    required this.createdAt,
    this.readAt,
  });
  final String id;
  final String title;
  final String body;
  final DateTime createdAt;
  final DateTime? readAt;

  factory NotificationItem.fromJson(Map<String, dynamic> json) =>
      NotificationItem(
        id: json['id'] as String,
        title: json['title'] as String,
        body: json['body'] as String,
        createdAt: DateTime.parse(json['createdAt'] as String),
        readAt: json['readAt'] == null
            ? null
            : DateTime.parse(json['readAt'] as String),
      );
}

class ReviewItem {
  const ReviewItem({
    required this.id,
    required this.fileName,
    required this.eventTitle,
    required this.contributorName,
    required this.previewUrl,
    required this.status,
    this.width,
    this.height,
    this.submittedAt,
    this.duplicateWarning,
    this.warnings,
  });
  final String id;
  final String fileName;
  final String eventTitle;
  final String contributorName;
  final String previewUrl;
  final String status;
  final int? width;
  final int? height;
  final DateTime? submittedAt;
  final String? duplicateWarning;
  final Object? warnings;

  factory ReviewItem.fromJson(Map<String, dynamic> json) => ReviewItem(
    id: json['id'] as String,
    fileName: json['fileName'] as String? ?? '',
    eventTitle:
        (json['event'] as Map<String, dynamic>?)?['title'] as String? ?? '',
    contributorName:
        (json['contributor'] as Map<String, dynamic>?)?['displayName']
            as String? ??
        '',
    previewUrl: json['previewUrl'] as String? ?? '',
    status: json['status'] as String? ?? '',
    width: (json['width'] as num?)?.toInt(),
    height: (json['height'] as num?)?.toInt(),
    submittedAt: json['submittedAt'] == null
        ? null
        : DateTime.parse(json['submittedAt'] as String),
    duplicateWarning: json['duplicateWarning'] as String?,
    warnings: json['warnings'],
  );
}

bool uploadWindowIsOpen(EventRecord event, DateTime now) {
  const uploadableStatuses = {'PUBLISHED', 'ONGOING', 'COMPLETED'};
  if (!uploadableStatuses.contains(event.status)) return false;
  if (event.uploadOpensAt != null && now.isBefore(event.uploadOpensAt!))
    return false;
  if (event.uploadClosesAt != null && now.isAfter(event.uploadClosesAt!))
    return false;
  return true;
}
